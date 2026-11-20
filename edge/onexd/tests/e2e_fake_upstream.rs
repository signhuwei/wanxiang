//! 对共用的 `tests/e2e/fake-upstream`（Bun）跑一遍 Chat 转换。
//! 需要先起假上游：`bun tests/e2e/fake-upstream/index.ts`（默认 127.0.0.1:3456）。
//! 假上游没在跑时跳过；设了 `ONEX_E2E_FAKE_UPSTREAM` 时用它的地址，且连不上算失败。

use std::sync::Arc;

use onex_core::ws::{Lease, Rate, Route, UpstreamAuth};
use onexd::outbox::now_ms;
use onexd::pricing::format_ms;
use onexd::router::{Outcome, Router};
use onexd::state::{ConfigSnapshot, State};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::mpsc;

#[tokio::test]
async fn anthropic_client_through_chat_fake_upstream() {
    let base = match std::env::var("ONEX_E2E_FAKE_UPSTREAM") {
        Ok(b) => b,
        Err(_) => {
            if tokio::net::TcpStream::connect("127.0.0.1:3456").await.is_err() {
                eprintln!("fake upstream not running on 127.0.0.1:3456; skipped");
                return;
            }
            "http://127.0.0.1:3456".into()
        }
    };
    let state = Arc::new(State::default());
    *state.config.write().unwrap() = ConfigSnapshot {
        agent_cache: false,
        revision: 1,
        agents: vec![],
        routes: vec![Route {
            model: "*".into(),
            model_id: "m".into(),
            provider_id: "p".into(),
            protocol: "openai_chat".into(),
            base_url: format!("{base}/v1"),
            upstream_model: None,
            auth: UpstreamAuth::Bearer,
            proxy: None,
        }],
        rates: vec![Rate {
            model_id: "m".into(),
            input_milli_per_mtok: 1_000_000,
            output_milli_per_mtok: 1_000_000,
            ..Default::default()
        }],
    };
    state.secrets.write().unwrap().insert("p".into(), "k".into());
    state
        .lease
        .grant(&Lease {
            id: "m".into(),
            re: None,
            lease_id: "l".into(),
            expires_at: format_ms(now_ms() + 600_000),
            budget_milli: 1_000_000,
            seq: 1,
        })
        .unwrap();
    let (tx, mut usage) = mpsc::unbounded_channel();
    let http = reqwest::Client::builder().no_proxy().build().unwrap();
    let app = Router::new(state, "t".into(), http.clone(), tx).app();
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1/messages", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });

    let send = |model: &str, stream: bool| {
        http.post(&url)
            .header("x-api-key", "t")
            .json(&json!({"model":model,"max_tokens":64,"stream":stream,"messages":[{"role":"user","content":"hi"}]}))
    };

    // 流式：文本拼起来是假上游的固定回答，用量取尾部 usage
    let text = send("fake-ok", true).send().await.unwrap().text().await.unwrap();
    let evs: Vec<Value> =
        text.lines().filter_map(|l| l.strip_prefix("data: ")).map(|d| serde_json::from_str(d).unwrap()).collect();
    let body: String = evs.iter().filter_map(|v| v["delta"]["text"].as_str()).collect();
    assert_eq!(body, "Hello from OneX.");
    assert_eq!(evs.last().unwrap()["type"], "message_stop");
    let md = evs.iter().find(|v| v["type"] == "message_delta").unwrap();
    assert_eq!((md["usage"]["input_tokens"].as_u64(), md["usage"]["output_tokens"].as_u64()), (Some(12), Some(5)));
    let u = usage.recv().await.unwrap();
    assert!(u.usage_final && u.outcome == Outcome::Ok && u.cost_milli == 17);

    // 非流式
    let v: Value = send("fake-ok", false).send().await.unwrap().json().await.unwrap();
    assert_eq!(v["content"][0]["text"], "Hello from OneX.");
    usage.recv().await.unwrap();

    // 断流：error 事件，complete=false
    let text = send("fake-disconnect", true).send().await.unwrap().text().await.unwrap();
    assert!(text.contains("event: error"), "{text}");
    assert!(!text.contains("message_stop"));
    let u = usage.recv().await.unwrap();
    assert!(!u.usage_final && u.outcome == Outcome::UpstreamError);

    // 上游 429：流开始前的 HTTP 错误
    let r = send("fake-429", true).send().await.unwrap();
    assert_eq!(r.status(), 429);
    assert_eq!(r.json::<Value>().await.unwrap()["error"]["type"], "rate_limit_error");
}
