//! `onex login`：验证租户账号，注册设备，再把 device_token 交给 onexd。
//!
//! 只有设备公钥离开本机；私钥一直在 onexd 内存里。登录和租户会话令牌只用于注册设备，用完即注销。

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use serde_json::{Value, json};

pub struct LoginArgs {
    pub server: String,
    pub target: String,
    pub invite: Option<String>,
    pub tenant: Option<String>,
    pub device_name: String,
    pub public_key: String,
}

pub struct PasswordLoginArgs<'a> {
    pub server: &'a str,
    pub tenant: &'a str,
    pub username: &'a str,
    pub password: &'a str,
    pub device_name: &'a str,
    pub public_key: &'a str,
}

#[derive(Debug, Deserialize)]
struct Tenant {
    id: String,
    name: String,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Registered {
    pub device_id: String,
    pub device_token: String,
    pub tenant_name: String,
}

/// `ask(prompt)` 从用户读一行（验证码、租户编号）。
pub async fn login(a: &LoginArgs, ask: &mut dyn FnMut(&str) -> Result<String>) -> Result<Registered> {
    let base = a.server.trim_end_matches('/');
    let http = client(base)?;
    let api = Api { http: &http, base };

    api.post("/v1/auth/code", None, json!({"target": a.target})).await.context("发送验证码失败")?;
    let code = ask(&format!("验证码已发送到 {}，请输入 6 位验证码：", a.target))?;
    let mut body = json!({"target": a.target, "code": code.trim(), "kind": "desktop"});
    if let Some(i) = &a.invite {
        body["invite_code"] = i.as_str().into();
    }
    let v = api.post("/v1/auth/login", None, body).await.context("登录失败")?;
    let global = str_field(&v, "token")?;
    let tenants: Vec<Tenant> = serde_json::from_value(v["tenants"].clone()).context("bad tenants in login reply")?;

    let r = register(&api, a, &global, &tenants, ask).await;
    // 会话令牌只为注册设备，失败也尽力注销
    let _ = api.post("/v1/auth/logout", Some(&global), json!({})).await;
    r
}

pub async fn login_password(a: &PasswordLoginArgs<'_>) -> Result<Registered> {
    let base = a.server.trim_end_matches('/');
    let http = client(base)?;
    let api = Api { http: &http, base };
    let reply = api
        .post(
            "/v1/auth/password-login",
            None,
            json!({"tenant": a.tenant, "username": a.username, "password": a.password, "kind": "desktop"}),
        )
        .await
        .context("登录失败")?;
    let scoped = str_field(&reply, "token")?;
    let result = async {
        let tenants: Vec<Tenant> = serde_json::from_value(reply["tenants"].clone()).context("无法读取登录租户")?;
        let [tenant] = tenants.as_slice() else { bail!("登录响应缺少唯一的租户") };
        register_device(&api, &scoped, tenant, a.device_name, a.public_key).await
    }
    .await;
    let _ = api.post("/v1/auth/logout", Some(&scoped), json!({})).await;
    result
}

fn client(base: &str) -> Result<reqwest::Client> {
    let mut builder = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none());
    // 本机测试地址直连，其余地址使用环境配置。
    let url = reqwest::Url::parse(base).context("服务地址无效")?;
    if matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]")) {
        builder = builder.no_proxy();
    }
    Ok(builder.build()?)
}

async fn register(
    api: &Api<'_>,
    a: &LoginArgs,
    global: &str,
    tenants: &[Tenant],
    ask: &mut dyn FnMut(&str) -> Result<String>,
) -> Result<Registered> {
    let tenant = pick_tenant(tenants, a.tenant.as_deref(), ask)?;
    let v = api
        .post("/v1/auth/select-tenant", Some(global), json!({"tenant_id": tenant.id, "kind": "desktop"}))
        .await
        .context("选择租户失败")?;
    let scoped = str_field(&v, "token")?;
    let result = register_device(api, &scoped, tenant, &a.device_name, &a.public_key).await;
    let _ = api.post("/v1/auth/logout", Some(&scoped), json!({})).await;
    result
}

async fn register_device(
    api: &Api<'_>,
    scoped: &str,
    tenant: &Tenant,
    device_name: &str,
    public_key: &str,
) -> Result<Registered> {
    let dev = api
        .post(
            "/v1/devices",
            Some(scoped),
            json!({"name": device_name, "os": onex_core::ipc::os_name(), "arch": onex_core::ipc::arch_name(),
                "public_key": public_key}),
        )
        .await
        .context("注册设备失败")?;
    Ok(Registered {
        device_id: str_field(&dev, "device_id")?,
        device_token: str_field(&dev, "device_token")?,
        tenant_name: tenant.name.clone(),
    })
}

fn pick_tenant<'a>(
    tenants: &'a [Tenant],
    wanted: Option<&str>,
    ask: &mut dyn FnMut(&str) -> Result<String>,
) -> Result<&'a Tenant> {
    if let Some(w) = wanted {
        return tenants.iter().find(|t| t.id == w || t.name == w).with_context(|| format!("你不在租户 {w} 中"));
    }
    match tenants {
        [] => bail!("这个账号还没有加入任何租户，请向管理员要邀请码，用 --invite 登录"),
        [t] => Ok(t),
        _ => {
            let list: Vec<String> =
                tenants.iter().enumerate().map(|(i, t)| format!("  {}. {}", i + 1, t.name)).collect();
            let n = ask(&format!("选择租户：\n{}\n编号：", list.join("\n")))?;
            let i: usize = n.trim().parse().ok().filter(|i| (1..=tenants.len()).contains(i)).context("租户编号无效")?;
            Ok(&tenants[i - 1])
        }
    }
}

fn str_field(v: &Value, k: &str) -> Result<String> {
    v.get(k).and_then(Value::as_str).map(str::to_owned).with_context(|| format!("server reply has no {k}"))
}

struct Api<'a> {
    http: &'a reqwest::Client,
    base: &'a str,
}

impl Api<'_> {
    async fn post(&self, path: &str, token: Option<&str>, body: Value) -> Result<Value> {
        let mut req = self.http.post(format!("{}{path}", self.base)).json(&body);
        if let Some(t) = token {
            req = req.bearer_auth(t);
        }
        let resp = req.send().await.with_context(|| format!("连接 {} 失败", self.base))?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if !status.is_success() {
            let code = v.pointer("/error/code").and_then(Value::as_str).unwrap_or("");
            if path == "/v1/auth/password-login" {
                if status.as_u16() == 429 {
                    bail!("尝试太频繁，请稍后再试");
                }
                if status.as_u16() == 401 {
                    bail!("租户、用户名或密码无效。使用简称无法登录时，可以输入租户 ID");
                }
                bail!("登录服务返回 HTTP {}", status.as_u16());
            }
            let hint = match code {
                "unauthenticated" if path == "/v1/auth/login" => {
                    "验证码错误或已过期，或这个账号还没有加入租户（需要 --invite）"
                }
                "rate_limited" => "尝试太频繁，请稍后再试",
                "seat_limit" => "租户人数已满，请联系管理员",
                "not_found" if path == "/v1/auth/login" => "邀请码无效或已用完",
                _ => "",
            };
            let msg = v.pointer("/error/message").and_then(Value::as_str).unwrap_or("");
            bail!("HTTP {} {code} {msg} {hint}", status.as_u16());
        }
        Ok(v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Json;
    use axum::http::{HeaderMap, StatusCode};
    use axum::response::IntoResponse;
    use axum::routing::post;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct Seen {
        calls: Vec<(String, Option<String>, Value)>,
    }

    async fn fake_server(two_tenants: bool) -> (String, Arc<Mutex<Seen>>) {
        let seen = Arc::new(Mutex::new(Seen::default()));
        let rec = |path: &'static str, s: Arc<Mutex<Seen>>| {
            move |h: HeaderMap, Json(b): Json<Value>| {
                let s = s.clone();
                async move {
                    let auth = h.get("authorization").map(|v| v.to_str().unwrap().to_string());
                    s.lock().unwrap().calls.push((path.into(), auth.clone(), b.clone()));
                    match path {
                        "/v1/auth/code" => StatusCode::ACCEPTED.into_response(),
                        "/v1/auth/login" if b["code"] != "123456" => (
                            StatusCode::UNAUTHORIZED,
                            Json(json!({"error":{"code":"unauthenticated","message":"bad"}})),
                        )
                            .into_response(),
                        "/v1/auth/login" => {
                            let mut tenants = vec![json!({"id":"ten_a","name":"甲公司","role":"member"})];
                            if two_tenants {
                                tenants.push(json!({"id":"ten_b","name":"乙公司","role":"member"}));
                            }
                            Json(json!({"token":"global","user":{},"tenants":tenants})).into_response()
                        }
                        "/v1/auth/password-login" if b["password"] != "form-password" => (
                            StatusCode::UNAUTHORIZED,
                            Json(json!({"error":{"code":"unauthenticated","message":"raw test exception"}})),
                        )
                            .into_response(),
                        "/v1/auth/password-login" => Json(json!({"token":"scoped_password",
                            "tenants":[{"id":"ten_a","name":"甲公司"}]}))
                        .into_response(),
                        "/v1/auth/select-tenant" => {
                            Json(json!({"token": format!("scoped_{}", b["tenant_id"].as_str().unwrap())}))
                                .into_response()
                        }
                        "/v1/devices" => {
                            (StatusCode::CREATED, Json(json!({"device_id":"dev_1","device_token":"dtok"})))
                                .into_response()
                        }
                        _ => StatusCode::NO_CONTENT.into_response(),
                    }
                }
            }
        };
        let mut app = axum::Router::new();
        for p in [
            "/v1/auth/code",
            "/v1/auth/login",
            "/v1/auth/password-login",
            "/v1/auth/select-tenant",
            "/v1/devices",
            "/v1/auth/logout",
        ] {
            app = app.route(p, post(rec(p, seen.clone())));
        }
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", l.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        (url, seen)
    }

    fn args(server: &str) -> LoginArgs {
        LoginArgs {
            server: server.into(),
            target: "a@example.test".into(),
            invite: Some("INV".into()),
            tenant: None,
            device_name: "Mac".into(),
            public_key: "PUB".into(),
        }
    }

    #[tokio::test]
    async fn password_login_registers_with_the_scoped_token_and_revokes_it() {
        let (url, seen) = fake_server(false).await;
        let mut args = PasswordLoginArgs {
            server: &url,
            tenant: "OneC",
            username: "zhangwei",
            password: "form-password",
            device_name: "Mac",
            public_key: "PUB",
        };
        let registered = login_password(&args).await.unwrap();
        assert_eq!(registered.tenant_name, "甲公司");
        {
            let seen = seen.lock().unwrap();
            assert_eq!(seen.calls.len(), 3);
            assert_eq!(
                seen.calls[0],
                (
                    "/v1/auth/password-login".into(),
                    None,
                    json!({"tenant":"OneC","username":"zhangwei","password":"form-password","kind":"desktop"})
                )
            );
            assert_eq!(seen.calls[1].0, "/v1/devices");
            assert_eq!(seen.calls[1].1.as_deref(), Some("Bearer scoped_password"));
            assert_eq!(seen.calls[1].2["public_key"], "PUB");
            assert_eq!(seen.calls[2].0, "/v1/auth/logout");
            assert_eq!(seen.calls[2].1.as_deref(), Some("Bearer scoped_password"));
        }

        args.password = "bad-password";
        let error = format!("{:#}", login_password(&args).await.unwrap_err());
        assert!(error.contains("租户、用户名或密码无效"));
        assert!(!error.contains("bad-password"));
        assert!(!error.contains("raw test exception"));
        assert_eq!(seen.lock().unwrap().calls.len(), 4);
    }

    #[tokio::test]
    async fn full_flow_registers_device_and_logs_out_sessions() {
        let (url, seen) = fake_server(true).await;
        let mut answers = vec!["2".to_string(), " 123456\n".to_string()];
        let r = login(&args(&url), &mut |_| Ok(answers.pop().unwrap())).await.unwrap();
        assert_eq!(
            r,
            Registered { device_id: "dev_1".into(), device_token: "dtok".into(), tenant_name: "乙公司".into() }
        );
        let calls = &seen.lock().unwrap().calls;
        let paths: Vec<&str> = calls.iter().map(|c| c.0.as_str()).collect();
        assert_eq!(
            paths,
            [
                "/v1/auth/code",
                "/v1/auth/login",
                "/v1/auth/select-tenant",
                "/v1/devices",
                "/v1/auth/logout",
                "/v1/auth/logout"
            ]
        );
        assert_eq!(calls[1].2, json!({"target":"a@example.test","code":"123456","kind":"desktop","invite_code":"INV"}));
        assert_eq!(calls[2].1.as_deref(), Some("Bearer global"));
        assert_eq!(calls[3].1.as_deref(), Some("Bearer scoped_ten_b"));
        assert_eq!(calls[3].2["public_key"], "PUB");
        assert_eq!(calls[3].2["os"], onex_core::ipc::os_name());
        // 两个会话令牌都注销
        assert_eq!(calls[4].1.as_deref(), Some("Bearer scoped_ten_b"));
        assert_eq!(calls[5].1.as_deref(), Some("Bearer global"));
    }

    #[tokio::test]
    async fn wrong_code_explains() {
        let (url, _) = fake_server(false).await;
        let e = login(&args(&url), &mut |_| Ok("000000".into())).await.unwrap_err();
        assert!(format!("{e:#}").contains("验证码错误"), "{e:#}");
    }

    #[tokio::test]
    async fn single_tenant_needs_no_prompt_and_tenant_flag_selects() {
        let (url, _) = fake_server(false).await;
        let mut asked = 0;
        login(&args(&url), &mut |_| {
            asked += 1;
            Ok("123456".into())
        })
        .await
        .unwrap();
        assert_eq!(asked, 1);

        let (url, _) = fake_server(true).await;
        let a = LoginArgs { tenant: Some("甲公司".into()), ..args(&url) };
        assert_eq!(login(&a, &mut |_| Ok("123456".into())).await.unwrap().tenant_name, "甲公司");
        let a = LoginArgs { tenant: Some("ten_x".into()), ..args(&url) };
        assert!(login(&a, &mut |_| Ok("123456".into())).await.is_err());
    }
}
