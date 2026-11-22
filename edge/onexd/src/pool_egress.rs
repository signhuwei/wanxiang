//! Routes may only send their scoped inference credential to the signed upstream itself.
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use onex_core::ws::Route;
use reqwest::{Client, Url};

use crate::state::PoolExecution;

pub(crate) fn parse_url(raw: &str, scheme: &str) -> Option<Url> {
    let url = Url::parse(raw).ok()?;
    (url.scheme() == scheme
        && url.has_host()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none())
    .then_some(url)
}

pub(crate) fn loopback(raw: &str, scheme: &str) -> bool {
    parse_url(raw, scheme).and_then(|url| literal_host(&url)).is_some_and(|ip| ip.is_loopback())
}

fn literal_host(url: &Url) -> Option<IpAddr> {
    url.host_str()?.trim_matches(['[', ']']).parse().ok()
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !ip.is_private()
                && !ip.is_loopback()
                && !ip.is_link_local()
                && a != 0
                && a < 224
                && !(a == 100 && (64..128).contains(&b))
                && !matches!((a, b, c), (192, 0, 0 | 2) | (198, 51, 100) | (203, 0, 113))
                && !(a == 198 && matches!(b, 18 | 19))
        }
        IpAddr::V6(ip) => {
            let [a, b, ..] = ip.segments();
            (0x2000..0x4000).contains(&a)
                && a != 0x2002 // 6to4 can encode a non-public IPv4 address.
                && !(a == 0x2001 && (b <= 0x01ff || b == 0x0db8))
                && a != 0x3fff // documentation block.
        }
    }
}

pub(crate) async fn responses_target(route: &Route, mode: PoolExecution, time: Duration) -> Option<(Client, Url)> {
    if route.protocol != "openai_responses" || route.proxy.as_deref().is_some_and(|proxy| proxy != "none") {
        return None;
    }
    let mut url = match mode {
        PoolExecution::Isolated if loopback(&route.base_url, "http") => parse_url(&route.base_url, "http")?,
        PoolExecution::Isolated => return None,
        PoolExecution::Production => parse_url(&route.base_url, "https")?,
    };
    let mut client =
        Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).retry(reqwest::retry::never());
    if mode == PoolExecution::Production {
        if let Some(ip) = literal_host(&url) {
            if !public_ip(ip) {
                return None;
            }
        } else {
            let host = url.host_str()?;
            if !host.trim_end_matches('.').contains('.') || host.trim_end_matches('.').ends_with(".local") {
                return None;
            }
            let port = url.port_or_known_default()?;
            let addrs: Vec<SocketAddr> =
                tokio::time::timeout(time, tokio::net::lookup_host((host, port))).await.ok()?.ok()?.collect();
            // Reject mixed answers as well. The HTTP client resolves only to these validated addresses.
            if addrs.is_empty() || addrs.iter().any(|addr| !public_ip(addr.ip())) {
                return None;
            }
            client = client.resolve_to_addrs(host, &addrs);
        }
    }
    let path = url.path().trim_end_matches('/');
    let path = format!("{}/v1/responses", path.strip_suffix("/v1").unwrap_or(path));
    url.set_path(&path);
    Some((client.build().ok()?, url))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_addresses_exclude_internal_and_special_purpose_targets() {
        for host in [
            "127.0.0.1",
            "10.1.0.1",
            "100.100.100.200",
            "169.254.169.254",
            "::1",
            "::ffff:8.8.8.8",
            "fc00::1",
            "fe80::1",
            "2002:a00:1::1",
        ] {
            assert!(!public_ip(host.parse().unwrap()), "{host}");
        }
        for host in ["8.8.8.8", "2606:4700::1111"] {
            assert!(public_ip(host.parse().unwrap()), "{host}");
        }
        assert!(parse_url("https://example.com/v1", "https").is_some());
        for url in [
            "http://example.com",
            "https://user@example.com",
            "https://example.com/?auth=other",
            "https://example.com/#frag",
        ] {
            assert!(parse_url(url, "https").is_none(), "{url}");
        }
    }
}
