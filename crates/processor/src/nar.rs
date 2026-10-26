use anyhow::{anyhow, bail, Context, Result};
use std::{
    io::Read,
    sync::{Arc, Mutex},
};
use tokio::{
    io::{AsyncRead, AsyncWriteExt},
    task::JoinHandle,
};
use tokio_util::io::SyncIoBridge;

pub(crate) struct NarValidator {
    pub(crate) writer: tokio::io::DuplexStream,
    result: JoinHandle<Result<()>>,
}

impl NarValidator {
    pub(crate) fn spawn() -> Self {
        let (writer, reader) = tokio::io::duplex(8 * 1024 * 1024);
        let result = tokio::task::spawn_blocking(move || validate(reader));
        Self { writer, result }
    }

    pub(crate) async fn finish(self) -> Result<()> {
        let mut writer = self.writer;
        writer.shutdown().await.context("closing NAR validator")?;
        self.result.await.context("waiting for NAR validator")??;
        Ok(())
    }
}

fn validate(reader: tokio::io::DuplexStream) -> Result<()> {
    let mut shared = SharedReader(Arc::new(Mutex::new(SyncIoBridge::new(reader))));
    let decoder =
        nix_nar::Decoder::new(shared.clone()).map_err(|_| anyhow!("invalid NAR header"))?;
    for entry in decoder
        .entries()
        .map_err(|_| anyhow!("invalid NAR entry list"))?
    {
        if let nix_nar::Content::File { mut data, .. } =
            entry.map_err(|_| anyhow!("invalid NAR entry"))?.content
        {
            std::io::copy(&mut data, &mut std::io::sink()).context("reading NAR file")?;
        }
    }
    let mut trailing = [0u8; 1];
    if shared.read(&mut trailing)? != 0 {
        bail!("trailing bytes after NAR archive");
    }
    Ok(())
}

struct SharedReader<R>(Arc<Mutex<R>>);
impl<R> Clone for SharedReader<R> {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}
impl<R: Read> Read for SharedReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        self.0
            .lock()
            .map_err(|_| std::io::Error::other("NAR reader mutex poisoned"))?
            .read(buffer)
    }
}

pub(crate) struct LimitedReader<R> {
    inner: R,
    size: u64,
    limit: u64,
}
impl<R> LimitedReader<R> {
    pub(crate) fn new(inner: R, limit: u64) -> Self {
        Self {
            inner,
            size: 0,
            limit,
        }
    }
}
impl<R: AsyncRead + Unpin> AsyncRead for LimitedReader<R> {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        let before = buf.filled().len();
        let result = std::pin::Pin::new(&mut self.inner).poll_read(cx, buf);
        if let std::task::Poll::Ready(Ok(())) = &result {
            self.size += (buf.filled().len() - before) as u64;
            if self.size > self.limit {
                return std::task::Poll::Ready(Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "compressed input exceeds limit",
                )));
            }
        }
        result
    }
}
