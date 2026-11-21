//! Validate a full, device-scoped policy before it is visible to the router.

use std::collections::{HashMap, HashSet};

use onex_core::ws::{BalanceMode, Config, Policy, PolicyDisplayItem, PolicySummary, Welcome};

use crate::state::{AppliedPolicy, State};

const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
const MAX_DISPLAY_ITEMS: usize = 64;
const MAX_NOTICES: usize = 32;
const MAX_SCOPE_DEPTH: usize = 64;
const MAX_RESOURCES: usize = 4096;

fn valid_revision(value: u64) -> bool {
    (1..=MAX_SAFE_INTEGER).contains(&value)
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

fn short_text(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}

fn display_value(item: &PolicyDisplayItem) -> bool {
    let value = &item.value;
    match item.kind.as_str() {
        "boolean" => value.is_boolean(),
        "integer" | "money_milli" | "ratio_ppm" => value.as_u64().is_some_and(|n| n <= MAX_SAFE_INTEGER),
        "enum" | "text" => value.as_str().is_some_and(|s| s.len() <= 512 && !s.chars().any(char::is_control)),
        "resource_set" => value
            .as_array()
            .is_some_and(|items| items.len() <= 64 && items.iter().all(|item| item.as_str().is_some_and(identifier))),
        _ => false,
    }
}

pub(crate) fn matches_identity(policy: &PolicySummary, welcome: &Welcome) -> bool {
    policy.tenant_id == welcome.tenant_id && policy.user_id == welcome.user_id && policy.device_id == welcome.device_id
}

pub(crate) fn stage(
    state: &State,
    config: &Config,
    policy: Policy,
    previous: Option<&AppliedPolicy>,
) -> Result<AppliedPolicy, &'static str> {
    let Policy { mut summary, mut notices, balance, secrets, runtime, commerce_plan_id, search_tools } = policy;
    if !matches!((summary.abi, runtime.is_some()), (1, false) | (2, true)) {
        return Err("不支持的设备策略版本");
    }
    if commerce_plan_id.as_ref().is_some_and(|id| summary.abi < 2 || !identifier(id)) {
        return Err("商业方案标识无效");
    }
    let runtime = runtime.unwrap_or_default();
    if [
        runtime.max_output,
        runtime.requests_per_minute,
        runtime.tokens_per_minute,
        runtime.member_concurrent,
        runtime.key_concurrent,
    ]
    .into_iter()
    .flatten()
    .any(|value| !(1..=MAX_SAFE_INTEGER).contains(&value))
    {
        return Err("设备请求上限无效");
    }
    let revision = summary.policy_revision;
    if !valid_revision(config.revision as u64)
        || !valid_revision(revision)
        || !valid_revision(summary.platform_revision)
        || summary.tenant_revision.is_some_and(|value| !valid_revision(value))
        || previous.is_some_and(|prior| {
            prior.summary.policy_revision > revision || prior.summary.platform_revision > summary.platform_revision
        })
    {
        return Err("设备策略修订号无效或已回退");
    }
    let mut group_ids = HashSet::new();
    if summary.groups.len() > MAX_SCOPE_DEPTH
        || !summary
            .groups
            .iter()
            .all(|group| valid_revision(group.revision) && identifier(&group.id) && group_ids.insert(&group.id))
        || summary.member.as_ref().is_some_and(|member| !valid_revision(member.revision) || !identifier(&member.id))
    {
        return Err("设备策略组织来源无效");
    }
    let mut display_ids = HashSet::new();
    summary.display.retain(|item| {
        identifier(&item.id) && short_text(&item.title) && display_value(item) && display_ids.insert(item.id.clone())
    });
    summary.display.truncate(MAX_DISPLAY_ITEMS);
    notices.retain(|notice| {
        identifier(&notice.id)
            && identifier(&notice.kind)
            && short_text(&notice.title)
            && short_text(&notice.at)
            && valid_revision(notice.policy_revision)
            && notice.policy_revision <= revision
    });
    if let Some(prior) = previous {
        notices.extend(prior.notices.iter().cloned());
    }
    notices.sort_by(|left, right| (&right.at, &right.id).cmp(&(&left.at, &left.id)));
    let mut notice_ids = HashSet::new();
    notices.retain(|notice| notice_ids.insert(notice.id.clone()));
    notices.truncate(MAX_NOTICES);

    // Every route has a price and uses exactly one key in this same generation.
    if [config.routes.len(), config.rates.len(), config.agents.len(), secrets.len()]
        .into_iter()
        .any(|len| len > MAX_RESOURCES)
    {
        return Err("设备策略资源数量超过上限");
    }
    let mut balance_aliases = HashSet::new();
    if balance.as_ref().is_some_and(|routing| {
        routing.aliases.len() > MAX_RESOURCES * 2 // Each route can publish its pattern and one fixed desktop model.
            || (routing.mode != BalanceMode::Restricted && !routing.aliases.is_empty())
            || (routing.mode == BalanceMode::Stopped && !config.routes.is_empty())
            || !routing.aliases.iter().all(|alias| {
                short_text(&alias.model)
                    && matches!(alias.protocol.as_str(), "anthropic" | "openai_chat" | "openai_responses")
                    && balance_aliases.insert((&alias.model, &alias.protocol))
            })
    }) {
        return Err("设备策略余额路由无效");
    }
    let mut route_models = HashSet::new();
    let mut route_providers = HashSet::new();
    for route in &config.routes {
        let url_is_valid = reqwest::Url::parse(&route.base_url).is_ok_and(|url| {
            matches!(url.scheme(), "https" | "http")
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
                && url.fragment().is_none()
        });
        if !identifier(&route.model_id)
            || !identifier(&route.provider_id)
            || !short_text(&route.model)
            || !url_is_valid
            || !matches!(route.protocol.as_str(), "anthropic" | "openai_chat" | "openai_responses")
        {
            return Err("设备策略包含无效路由");
        }
        route_models.insert(route.model_id.as_str());
        route_providers.insert(route.provider_id.as_str());
    }
    let mut priced_models = HashSet::new();
    if !config.rates.iter().all(|rate| {
        route_models.contains(rate.model_id.as_str())
            && [
                rate.input_milli_per_mtok,
                rate.output_milli_per_mtok,
                rate.cache_read_milli_per_mtok,
                rate.cache_write_milli_per_mtok,
            ]
            .into_iter()
            .all(|value| value <= MAX_SAFE_INTEGER)
            && priced_models.insert(rate.model_id.as_str())
    }) || priced_models != route_models
    {
        return Err("设备策略路由与费率不一致");
    }
    let mut release_ids = HashSet::new();
    if !config.agents.iter().all(|release| {
        identifier(&release.agent)
            && short_text(&release.version)
            && release.os == onex_core::ipc::os_name()
            && release.arch == onex_core::ipc::arch_name()
            && crate::managed_runtime::is_server_artifact(release)
            && release.sha256.len() == 64
            && release.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            && release.size > 0
            && release.size <= 512 * 1024 * 1024
            && release_ids.insert(release.id.as_str())
    }) {
        return Err("设备策略包含不适用的受管发行");
    }
    crate::tools::validate_device_releases(&config.tools, onex_core::ipc::os_name(), onex_core::ipc::arch_name())
        .map_err(|_| "设备策略包含无效或不适用的受管工具")?;
    if !search_tools.is_empty() && commerce_plan_id.is_none() || !crate::hosted_search::valid_tools(&search_tools) {
        return Err("设备策略包含无效或无商业方案的搜索发行");
    }
    let mut keys = HashMap::new();
    for secret in secrets {
        if !route_providers.contains(secret.provider_id.as_str())
            || keys.contains_key(&secret.provider_id)
            || secret.ciphertext.len() > 16384
        {
            return Err("设备策略的密钥与路由不一致");
        }
        let plaintext = state
            .device_key
            .open(&secret.provider_id, &secret.key_id, &secret.nonce, &secret.ciphertext)
            .map_err(|_| "无法解密设备策略密钥")?;
        keys.insert(secret.provider_id, plaintext);
    }
    if keys.len() != route_providers.len() {
        return Err("设备策略缺少路由密钥");
    }
    Ok(AppliedPolicy { summary, notices, balance, keys, runtime, commerce_plan_id, search_tools })
}
