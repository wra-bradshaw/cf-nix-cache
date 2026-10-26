use std::pin::Pin;

use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use futures::TryStreamExt;
use reqwest::{Client, StatusCode, Url};
use tokio::io::AsyncRead;
use tokio_util::io::StreamReader;

pub(crate) type ObjectBody = Pin<Box<dyn AsyncRead + Send>>;

#[async_trait]
pub(crate) trait ObjectStore: Send + Sync {
    async fn get(&self, key: &str) -> Result<ObjectBody>;
    async fn put_if_absent(&self, key: &str, body: Vec<u8>, content_type: &str) -> Result<bool>;
}

#[derive(Clone)]
pub(crate) struct HttpObjectStore {
    endpoint: Url,
    client: Client,
}

impl HttpObjectStore {
    pub(crate) fn new(endpoint: &str) -> Result<Self> {
        let endpoint = Url::parse(endpoint).context("parsing OBJECT_STORE_ENDPOINT")?;
        if endpoint.cannot_be_a_base() || endpoint.host_str().is_none() {
            return Err(anyhow!("OBJECT_STORE_ENDPOINT must be an HTTP base URL"));
        }
        Ok(Self {
            endpoint,
            client: Client::new(),
        })
    }

    fn object_url(&self, key: &str) -> Result<Url> {
        let mut url = self.endpoint.clone();
        url.set_query(None);
        url.set_fragment(None);
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| anyhow!("OBJECT_STORE_ENDPOINT cannot contain object paths"))?;
        segments.clear();
        for segment in key.split('/') {
            segments.push(segment);
        }
        drop(segments);
        Ok(url)
    }
}

#[async_trait]
impl ObjectStore for HttpObjectStore {
    async fn get(&self, key: &str) -> Result<ObjectBody> {
        let response = self
            .client
            .get(self.object_url(key)?)
            .send()
            .await
            .with_context(|| format!("requesting object {key}"))?
            .error_for_status()
            .with_context(|| format!("reading object {key}"))?;
        let stream = response.bytes_stream().map_err(std::io::Error::other);
        Ok(Box::pin(StreamReader::new(stream)))
    }

    async fn put_if_absent(&self, key: &str, body: Vec<u8>, content_type: &str) -> Result<bool> {
        let response = self
            .client
            .put(self.object_url(key)?)
            .header(reqwest::header::IF_NONE_MATCH, "*")
            .header(reqwest::header::CONTENT_TYPE, content_type)
            .body(body)
            .send()
            .await
            .with_context(|| format!("requesting write of object {key}"))?;
        match response.status() {
            StatusCode::CREATED | StatusCode::NO_CONTENT => Ok(true),
            StatusCode::PRECONDITION_FAILED => Ok(false),
            _ => {
                response
                    .error_for_status()
                    .with_context(|| format!("writing object {key}"))?;
                Err(anyhow!(
                    "object store returned an unexpected success status"
                ))
            }
        }
    }
}

/// In-memory store for tests. Like R2 conditional writes, `put_if_absent`
/// leaves an existing object untouched and returns `false`.
#[cfg(test)]
pub(crate) mod memory {
    use super::*;
    use std::{
        collections::HashMap,
        io::Cursor,
        sync::{Arc, Mutex},
    };

    #[derive(Clone, Default)]
    pub(crate) struct MemoryStore {
        pub(crate) objects: Arc<Mutex<HashMap<String, Vec<u8>>>>,
        /// Every key passed to `put_if_absent`, including rejected writes.
        pub(crate) writes: Arc<Mutex<Vec<String>>>,
    }

    #[async_trait]
    impl ObjectStore for MemoryStore {
        async fn get(&self, key: &str) -> Result<ObjectBody> {
            let body = self
                .objects
                .lock()
                .unwrap()
                .get(key)
                .cloned()
                .context("missing object")?;
            Ok(Box::pin(Cursor::new(body)))
        }

        async fn put_if_absent(
            &self,
            key: &str,
            body: Vec<u8>,
            _content_type: &str,
        ) -> Result<bool> {
            self.writes.lock().unwrap().push(key.into());
            let mut objects = self.objects.lock().unwrap();
            if objects.contains_key(key) {
                return Ok(false);
            }
            objects.insert(key.into(), body);
            Ok(true)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{http::HeaderMap, Router};

    /// Serves one fixed status for every request (400 if the conditional
    /// header is missing) and performs one `put_if_absent` against it.
    async fn put_against(status: u16) -> Result<bool> {
        let app = Router::new().fallback(move |headers: HeaderMap| async move {
            if headers
                .get(reqwest::header::IF_NONE_MATCH)
                .map(|v| v.as_bytes())
                != Some(b"*")
            {
                return StatusCode::BAD_REQUEST;
            }
            StatusCode::from_u16(status).unwrap()
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await });
        HttpObjectStore::new(&format!("http://{address}"))
            .unwrap()
            .put_if_absent("chunks/x", vec![1], "application/zstd")
            .await
    }

    #[tokio::test]
    async fn put_if_absent_maps_conditional_write_statuses() {
        assert!(put_against(201).await.unwrap());
        assert!(!put_against(412).await.unwrap());
        assert!(put_against(200).await.is_err());
        assert!(put_against(500).await.is_err());
    }

    #[test]
    fn object_urls_preserve_path_segments() {
        let store = HttpObjectStore::new("http://cache.r2").unwrap();
        assert_eq!(
            store
                .object_url("manifests/v1/sha256:abc.json")
                .unwrap()
                .as_str(),
            "http://cache.r2/manifests/v1/sha256:abc.json"
        );
    }
}
