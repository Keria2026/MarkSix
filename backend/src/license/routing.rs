//! Signed activation envelopes carry bootstrap addresses. A durable discovery
//! endpoint (or an owner-signed migration file) supplies later addresses. Encoding
//! does not hide a domain from a machine's administrator.
use super::*;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Code {
    purpose: String,
    schema: u8,
    pub token: String,
    pub authority_url: String,
    pub discovery_url: Option<String>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Route {
    purpose: String,
    schema: u8,
    pub revision: i64,
    pub authority_url: String,
    pub discovery_url: Option<String>,
}
fn verify_bytes(certificate: &Certificate, key: &VerifyingKey) -> anyhow::Result<Vec<u8>> {
    ensure!(
        certificate.payload.len() <= 8192 && certificate.signature.len() == 128,
        "签名配置过长或无效"
    );
    let bytes = hex::decode(&certificate.payload)?;
    key.verify_strict(
        &bytes,
        &Signature::from_slice(&hex::decode(&certificate.signature)?)?,
    )?;
    Ok(bytes)
}
fn sign_value(value: &impl Serialize, key: &SigningKey) -> anyhow::Result<Certificate> {
    let bytes = serde_json::to_vec(value)?;
    Ok(Certificate {
        signature: hex::encode(key.sign(&bytes).to_bytes()),
        payload: hex::encode(bytes),
    })
}
pub(super) fn encode_code(
    token: &str,
    url: &str,
    discovery: Option<&str>,
    key: &SigningKey,
) -> anyhow::Result<String> {
    let code = Code {
        purpose: "marksix-activation".into(),
        schema: 1,
        token: token.to_owned(),
        authority_url: authority_url(url)?,
        discovery_url: discovery.map(authority_url).transpose()?,
    };
    let cert = sign_value(&code, key)?;
    Ok(format!(
        "MSX1.{}.{}",
        URL_SAFE_NO_PAD.encode(hex::decode(cert.payload)?),
        URL_SAFE_NO_PAD.encode(hex::decode(cert.signature)?)
    ))
}
pub(super) fn decode_code(input: &str, key: &VerifyingKey) -> anyhow::Result<Code> {
    ensure!(input.len() <= 8192, "激活码过长");
    let parts = input.trim().split('.').collect::<Vec<_>>();
    ensure!(parts.len() == 3 && parts[0] == "MSX1", "激活码格式错误");
    let cert = Certificate {
        payload: hex::encode(URL_SAFE_NO_PAD.decode(parts[1])?),
        signature: hex::encode(URL_SAFE_NO_PAD.decode(parts[2])?),
    };
    let code: Code = serde_json::from_slice(&verify_bytes(&cert, key)?)?;
    ensure!(
        code.purpose == "marksix-activation"
            && code.schema == 1
            && code.token.len() == 48
            && code.token.bytes().all(|b| b.is_ascii_hexdigit()),
        "激活码内容无效"
    );
    authority_url(&code.authority_url)?;
    if let Some(url) = &code.discovery_url {
        authority_url(url)?;
    }
    Ok(code)
}
pub(super) fn decode_route(certificate: &Certificate, key: &VerifyingKey) -> anyhow::Result<Route> {
    let route: Route = serde_json::from_slice(&verify_bytes(certificate, key)?)?;
    ensure!(
        route.purpose == "marksix-authority-route" && route.schema == 1 && route.revision > 0,
        "迁移文件内容无效"
    );
    authority_url(&route.authority_url)?;
    if let Some(url) = &route.discovery_url {
        authority_url(url)?;
    }
    Ok(route)
}
pub(super) fn signed_route(
    key: &SigningKey,
    url: &str,
    discovery: Option<&str>,
    revision: i64,
) -> anyhow::Result<Certificate> {
    ensure!(revision > 0, "服务地址版本须为正整数");
    sign_value(
        &Route {
            purpose: "marksix-authority-route".into(),
            schema: 1,
            revision,
            authority_url: authority_url(url)?,
            discovery_url: discovery.map(authority_url).transpose()?,
        },
        key,
    )
}
pub fn route_document(
    url: &str,
    discovery: Option<&str>,
    revision: i64,
) -> anyhow::Result<Certificate> {
    signed_route(&load_key()?, url, discovery, revision)
}

pub(super) async fn discover(url: &str) -> anyhow::Result<Certificate> {
    let url = authority_url(url)?;
    let mut response = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()?
        .get(url)
        .send()
        .await?
        .error_for_status()?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(bytes.len() + chunk.len() <= 16384, "服务发现响应过大");
        bytes.extend_from_slice(&chunk);
    }
    Ok(serde_json::from_slice(&bytes)?)
}

#[derive(Default)]
pub(super) struct Resolution {
    pub url: String,
    pub discovery: Option<String>,
    pub revision: i64,
    pub certificate: Option<Certificate>,
}
pub(super) async fn resolve(
    state: &AppState,
    client: &Client,
    url: &str,
    discovery: Option<String>,
    supplied: Option<Certificate>,
) -> ApiResult<Resolution> {
    let row = sqlx::query("SELECT route_revision,route_certificate FROM client_license WHERE id=1")
        .fetch_one(&state.pool)
        .await?;
    let revision: i64 = row.try_get("route_revision")?;
    let stored: Option<DbJson<Certificate>> = row.try_get("route_certificate")?;
    let mut result = Resolution {
        url: authority_url(url).map_err(|e| activation_error(e.to_string()))?,
        discovery,
        revision,
        certificate: stored.map(|v| v.0),
    };
    if let Some(cert) = &result.certificate {
        let route = decode_route(cert, &client.key)
            .map_err(|_| activation_error("已保存的服务迁移签名无效"))?;
        if route.revision != revision {
            return Err(activation_error("已保存的服务地址版本不一致"));
        }
        result.url = route.authority_url;
        result.discovery = route.discovery_url.or(result.discovery);
    }
    if let Some(cert) = supplied {
        let route = decode_route(&cert, &client.key)
            .map_err(|_| activation_error("迁移文件签名或内容无效"))?;
        if route.revision < revision {
            return Err(activation_error("迁移文件版本已过期"));
        }
        result.url = route.authority_url;
        result.discovery = route.discovery_url;
        result.revision = route.revision;
        result.certificate = Some(cert);
    }
    if let Some(url) = &result.discovery {
        // A discovery transport outage does not discard the last signed address;
        // the authority still must return a fresh, valid license certificate.
        if let Ok(cert) = discover(url).await {
            let route = decode_route(&cert, &client.key)
                .map_err(|_| activation_error("服务发现签名无效"))?;
            if route.revision < result.revision {
                return Err(activation_error("服务发现版本回退"));
            }
            result.url = route.authority_url;
            result.discovery = route.discovery_url.or(result.discovery);
            result.revision = route.revision;
            result.certificate = Some(cert);
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn activation_envelope_authenticates_embedded_addresses() {
        let key = SigningKey::generate(&mut rand::rngs::OsRng);
        let token = random_hex();
        let text = encode_code(
            &token,
            "https://old.example.com",
            Some("https://discovery.example.com/route.json"),
            &key,
        )
        .unwrap();
        let code = decode_code(&text, &key.verifying_key()).unwrap();
        assert_eq!(code.token, token);
        assert_eq!(code.authority_url, "https://old.example.com");
        assert!(
            decode_code(
                &text,
                &SigningKey::generate(&mut rand::rngs::OsRng).verifying_key()
            )
            .is_err()
        );
        let changed = text.replacen("MSX1.", "MSX2.", 1);
        assert!(decode_code(&changed, &key.verifying_key()).is_err());
        assert!(encode_code(&token, "http://remote.example.com", None, &key).is_err());
    }
}
