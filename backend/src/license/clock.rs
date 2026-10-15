//! License time is anchored exclusively to signed authority time. Nothing from
//! the customer's wall clock is accepted as license time or persisted as a lease.
use anyhow::ensure;
use std::time::Duration;

pub(super) fn boot_time() -> anyhow::Result<Duration> {
    #[cfg(target_os = "linux")]
    {
        let mut value = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // SAFETY: value is writable, correctly aligned, and lives through this call.
        let result = unsafe { libc::clock_gettime(libc::CLOCK_BOOTTIME, &mut value) };
        ensure!(
            result == 0 && value.tv_sec >= 0 && (0..1_000_000_000).contains(&value.tv_nsec),
            "无法读取授权单调时钟"
        );
        Ok(Duration::new(value.tv_sec as u64, value.tv_nsec as u32))
    }
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetTickCount64() -> u64;
        }
        // SAFETY: GetTickCount64 has no parameters or memory preconditions. Its
        // uptime includes sleep/hibernation and is independent of the wall clock.
        Ok(Duration::from_millis(unsafe { GetTickCount64() }))
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        anyhow::bail!("此平台不支持授权单调时钟")
    }
}

#[derive(Clone)]
pub(super) struct Lease {
    pub license_id: String,
    pub fingerprint: String,
    pub binding: String,
    pub started: Duration,
    pub server_time: i64,
    pub expires_at: i64,
}
impl Lease {
    pub fn remaining(&self, now: Duration) -> anyhow::Result<u64> {
        let elapsed = now
            .checked_sub(self.started)
            .ok_or_else(|| anyhow::anyhow!("授权单调时钟异常，请重新联网核验"))?;
        ensure!(
            self.server_time >= 0 && self.expires_at > self.server_time,
            "授权已到期"
        );
        Ok(
            Duration::from_secs((self.expires_at - self.server_time) as u64)
                .saturating_sub(elapsed)
                .as_secs(),
        )
    }
    pub fn fresh(&self, now: Duration) -> bool {
        now.checked_sub(self.started)
            .is_some_and(|elapsed| elapsed < Duration::from_secs(60))
    }
}
#[derive(Default)]
pub(super) struct Runtime {
    pub lease: Option<Lease>,
    pub failure: Option<(Duration, String)>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn uptime_is_monotonic_and_lease_includes_suspend_and_rejects_rollback() {
        let a = boot_time().unwrap();
        let b = boot_time().unwrap();
        assert!(b >= a);
        let lease = Lease {
            license_id: "id".into(),
            fingerprint: "x".into(),
            binding: "b".into(),
            started: Duration::from_secs(100),
            server_time: 1_000,
            expires_at: 1_120,
        };
        assert_eq!(lease.remaining(Duration::from_secs(119)).unwrap(), 101);
        assert!(!lease.fresh(Duration::from_secs(160)));
        assert_eq!(lease.remaining(Duration::from_secs(220)).unwrap(), 0);
        assert!(lease.remaining(Duration::from_secs(99)).is_err());
    }
}
