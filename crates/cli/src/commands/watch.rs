use crate::protocol::CacheName;
use anyhow::{bail, Context, Result};
use std::{
    collections::BTreeSet,
    fs::{self, File},
    io::{self, Read, Seek, SeekFrom},
    num::NonZeroUsize,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

use super::push::push;
use crate::client::Api;

/// The files a post-build hook and the watcher share. The hook appends each
/// build's `$OUT_PATHS` to `queue`.
struct Spool(PathBuf);

impl Spool {
    fn queue(&self) -> PathBuf {
        self.0.join("queue")
    }
    fn batch(&self) -> PathBuf {
        self.0.join("batch")
    }
    fn stop(&self) -> PathBuf {
        self.0.join("stop")
    }
    fn pid(&self) -> PathBuf {
        self.0.join("pid")
    }
    fn log(&self) -> PathBuf {
        self.0.join("log")
    }
    fn status(&self) -> PathBuf {
        self.0.join("status")
    }

    /// Moves the queue aside so new builds start a fresh one, and returns the
    /// distinct paths in it that still exist.
    async fn take(&self) -> Result<Vec<String>> {
        match fs::rename(self.queue(), self.batch()) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        }
        // A hook that opened the queue before the rename may still be writing.
        tokio::time::sleep(Duration::from_secs(1)).await;
        let paths = existing_paths(&fs::read_to_string(self.batch())?);
        fs::remove_file(self.batch())?;
        Ok(paths)
    }
}

fn existing_paths(text: &str) -> Vec<String> {
    text.split_whitespace()
        .filter(|path| Path::new(path).exists())
        .map(String::from)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

pub(super) async fn run(
    api: Api,
    cache: CacheName,
    spool: PathBuf,
    jobs: NonZeroUsize,
    interval: Duration,
) -> Result<()> {
    let spool = Spool(spool);
    fs::create_dir_all(&spool.0)?;
    let result = drain(&api, &cache, &spool, jobs, interval).await;
    fs::write(spool.status(), if result.is_ok() { "ok" } else { "failed" })?;
    result
}

async fn drain(
    api: &Api,
    cache: &CacheName,
    spool: &Spool,
    jobs: NonZeroUsize,
    interval: Duration,
) -> Result<()> {
    let mut failed = BTreeSet::new();
    loop {
        // Checked before taking the queue, so builds queued before the stop
        // are still pushed.
        let stopping = spool.stop().exists();
        let paths = spool.take().await?;
        if !paths.is_empty() {
            println!("pushing {} built paths", paths.len());
            if let Err(error) = push(api.clone(), cache.clone(), paths.clone(), jobs, false).await {
                eprintln!("{error:#}");
                failed.extend(paths);
            }
        } else if stopping {
            break;
        } else {
            tokio::time::sleep(interval).await;
        }
    }
    if failed.is_empty() {
        return Ok(());
    }
    let paths = existing_paths(&failed.into_iter().collect::<Vec<_>>().join("\n"));
    println!("retrying {} paths that failed to push", paths.len());
    push(api.clone(), cache.clone(), paths, jobs, false).await
}

/// Runs `watch run` in the background, logging to the spool.
pub(super) fn start(run_args: &[String], spool: &Path) -> Result<()> {
    let spool = Spool(spool.into());
    fs::create_dir_all(&spool.0)?;
    for file in [spool.stop(), spool.status()] {
        remove_if_present(&file)?;
    }
    let log = File::create(spool.log())?;
    let child = Command::new(std::env::current_exe()?)
        .args(run_args)
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .spawn()
        .context("failed to start the watcher")?;
    fs::write(spool.pid(), child.id().to_string())?;
    println!("watching {} (pid {})", spool.queue().display(), child.id());
    Ok(())
}

/// Asks the watcher to push what is left, waits for it while echoing its log,
/// and fails if any path could not be pushed.
pub(super) async fn stop(spool: &Path) -> Result<()> {
    let spool = Spool(spool.into());
    let pid = fs::read_to_string(spool.pid())
        .with_context(|| format!("no watcher was started in {}", spool.0.display()))?;
    File::create(spool.stop())?;
    let mut log = File::open(spool.log())?;
    let mut offset = 0;
    while alive(pid.trim())? {
        offset = echo(&mut log, offset)?;
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    echo(&mut log, offset)?;
    match fs::read_to_string(spool.status()).as_deref() {
        Ok("ok") => Ok(()),
        Ok(_) => bail!("some built paths could not be pushed"),
        Err(_) => bail!("the watcher exited without finishing"),
    }
}

fn echo(log: &mut File, offset: u64) -> Result<u64> {
    log.seek(SeekFrom::Start(offset))?;
    let mut text = String::new();
    let read = log.read_to_string(&mut text)?;
    print!("{text}");
    Ok(offset + read as u64)
}

fn alive(pid: &str) -> Result<bool> {
    Ok(Command::new("kill")
        .args(["-0", pid])
        .stderr(Stdio::null())
        .status()?
        .success())
}

fn remove_if_present(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error.into()),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs::OpenOptions, io::Write};

    fn append(path: &Path, text: &str) {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        file.write_all(text.as_bytes()).unwrap();
    }

    #[tokio::test]
    async fn take_returns_distinct_existing_paths_and_empties_the_queue() {
        let dir = tempfile::tempdir().unwrap();
        let spool = Spool(dir.path().into());
        let real = dir.path().join("real");
        fs::write(&real, "").unwrap();
        let real = real.display().to_string();
        append(&spool.queue(), &format!("{real} /nonexistent\n{real}\n"));
        assert_eq!(spool.take().await.unwrap(), vec![real]);
        assert!(!spool.queue().exists());
        assert!(spool.take().await.unwrap().is_empty());
    }
}
