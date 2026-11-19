//! 本机 IPC 的传输层：Unix 用 socket 文件，Windows 用具名管道。两边都是同一套按行分隔的
//! JSON 协议（见 `ipc` 模块），这里只封装"怎么建连接、怎么等下一个连接"，行协议本身不在这里。
//!
//! Windows 的具名管道默认创建者可读写，同机其它用户和远程机器都连不上（`\\.\pipe\` 命名空间
//! 本身不跨网络），但要把 ACL 显式收紧到当前用户 SID（而不是默认的"创建者 + Everyone 读"之类
//! 宽松继承），必须用 `CreateNamedPipeW` 的 `lpSecurityAttributes`。`ServerOptions` 提供了
//! `create_with_security_attributes_raw` 正是为此设计。

use std::io;
use std::path::Path;

#[cfg(unix)]
pub use unix_impl::*;
#[cfg(windows)]
pub use windows_impl::*;

#[cfg(unix)]
mod unix_impl {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    pub type ReadHalf = tokio::net::unix::OwnedReadHalf;
    pub type WriteHalf = tokio::net::unix::OwnedWriteHalf;
    pub struct Listener(tokio::net::UnixListener);
    pub struct Connection(tokio::net::UnixStream);

    impl Connection {
        pub fn into_split(self) -> (ReadHalf, WriteHalf) {
            self.0.into_split()
        }
    }

    /// 绑定 socket，权限 0600。已有 socket 能连上说明另一个 onexd 在跑，报错退出；
    /// 连不上就是残留文件，删掉重建。
    pub async fn bind(path: &Path) -> anyhow::Result<Listener> {
        use anyhow::{Context, bail};
        if path.exists() {
            if tokio::net::UnixStream::connect(path).await.is_ok() {
                bail!("another onexd is listening on {}", path.display());
            }
            std::fs::remove_file(path).with_context(|| format!("remove stale socket {}", path.display()))?;
        }
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let l = tokio::net::UnixListener::bind(path).with_context(|| format!("bind {}", path.display()))?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        Ok(Listener(l))
    }

    impl Listener {
        pub async fn accept(&self) -> io::Result<Connection> {
            self.0.accept().await.map(|(s, _)| Connection(s))
        }
    }

    /// 连接失败时附带的提示：Unix 下直接报连接错误即可，调用方自己拼"onexd 是否在跑"之类的话。
    pub async fn connect(path: &Path) -> io::Result<Connection> {
        tokio::net::UnixStream::connect(path).await.map(Connection)
    }

    /// 关停时清理 socket 文件；Windows 的具名管道没有对应文件，调用方不需要关心这一步的差异。
    pub fn cleanup(path: &Path) {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(windows)]
mod windows_impl {
    use super::*;
    use std::pin::Pin;
    use std::task::{Context as TaskContext, Poll};
    use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
    use tokio::net::windows::named_pipe;

    /// 服务端连接用 `NamedPipeServer`，客户端连接（`connect()`）用 `NamedPipeClient`——两个不同的
    /// 具体类型，但对调用方来说都只是"一条双向字节流"，所以这里统一成一个枚举，`AsyncRead`/
    /// `AsyncWrite` 各写一份转发，调用方（`handle()`、`call()`）不需要关心具体是哪一种。
    pub enum Connection {
        Server(named_pipe::NamedPipeServer),
        Client(named_pipe::NamedPipeClient),
    }

    impl AsyncRead for Connection {
        fn poll_read(self: Pin<&mut Self>, cx: &mut TaskContext<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
            match self.get_mut() {
                Connection::Server(s) => Pin::new(s).poll_read(cx, buf),
                Connection::Client(c) => Pin::new(c).poll_read(cx, buf),
            }
        }
    }

    impl AsyncWrite for Connection {
        fn poll_write(self: Pin<&mut Self>, cx: &mut TaskContext<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
            match self.get_mut() {
                Connection::Server(s) => Pin::new(s).poll_write(cx, buf),
                Connection::Client(c) => Pin::new(c).poll_write(cx, buf),
            }
        }
        fn poll_flush(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
            match self.get_mut() {
                Connection::Server(s) => Pin::new(s).poll_flush(cx),
                Connection::Client(c) => Pin::new(c).poll_flush(cx),
            }
        }
        fn poll_shutdown(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
            match self.get_mut() {
                Connection::Server(s) => Pin::new(s).poll_shutdown(cx),
                Connection::Client(c) => Pin::new(c).poll_shutdown(cx),
            }
        }
    }

    pub type ReadHalf = tokio::io::ReadHalf<Connection>;
    pub type WriteHalf = tokio::io::WriteHalf<Connection>;

    impl Connection {
        pub fn into_split(self) -> (ReadHalf, WriteHalf) {
            tokio::io::split(self)
        }
    }

    /// 服务端：`bind()` 创建的第一条管道实例（`first_pipe_instance(true)`，用来检测"已有 onexd 在
    /// 跑"）一直留着给第一个 `accept()` 用，不提前销毁——否则在它销毁、下一条实例建好之前有一个
    /// 空档，这段时间里第二个 onexd 能抢到同名管道，等于没真正互斥。`accept()` 用掉这条存好的实例后
    /// 再建新的排队，后续调用都是"先建后等"。只存 SDDL 字符串对应的安全描述符字节（`Send`、跨
    /// `.await` 安全）；每次真正调用 `create_with_security_attributes_raw` 前才现场拼一个
    /// `SECURITY_ATTRIBUTES`，用完立即丢，不让裸指针跨 await 点存活。
    pub struct Listener {
        pipe_name: String,
        sd: Vec<u8>,
        next: tokio::sync::Mutex<Option<named_pipe::NamedPipeServer>>,
    }

    /// `path` 和 Unix 共用同一个调用约定（`<ONEX_HOME>/onexd.sock`），这里只取文件名部分派生管道名，
    /// 不在文件系统里创建任何东西。管道名按 `ONEX_HOME` 区分，和 Unix socket 路径按目录区分是同一个
    /// 目的：同一台机器装多份 onexd（不同 `ONEX_HOME`）互不干扰。
    fn pipe_name(path: &Path) -> String {
        let scope = path.parent().map(|p| p.display().to_string()).unwrap_or_default();
        let digest = {
            use std::collections::hash_map::DefaultHasher;
            use std::hash::{Hash, Hasher};
            let mut h = DefaultHasher::new();
            scope.hash(&mut h);
            h.finish()
        };
        format!(r"\\.\pipe\onex-{digest:016x}")
    }

    /// 创建一条监听中的管道实例，ACL 收紧到"当前用户完全控制，不给 Everyone/Authenticated Users，
    /// 不给远程"。`sd` 是 `super::sddl::current_user_security_descriptor()` 生成的安全描述符字节；
    /// 每次调用都现场拼一份 `SECURITY_ATTRIBUTES` 指向它，调用结束后这份临时结构体立即失效，不保留
    /// 给下一次用（`SECURITY_ATTRIBUTES` 本身很小，重新拼的开销可忽略）。
    fn create_instance(pipe_name: &str, sd: &[u8], first: bool) -> io::Result<named_pipe::NamedPipeServer> {
        let sa = windows_sys::Win32::Security::SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<windows_sys::Win32::Security::SECURITY_ATTRIBUTES>() as u32,
            // `sd` 外部不会再被改写（`Listener`/`bind` 之后只读），这里转成可变指针只是 Win32 API
            // 的签名要求，系统不会写回这块内存。
            lpSecurityDescriptor: sd.as_ptr() as *mut std::ffi::c_void,
            bInheritHandle: 0,
        };
        let mut options = named_pipe::ServerOptions::new();
        options.reject_remote_clients(true);
        if first {
            options.first_pipe_instance(true);
        }
        // SAFETY: `create_with_security_attributes_raw` 要求 `attrs` 指向一个在调用期间有效的
        // `SECURITY_ATTRIBUTES`；`sa` 活到这次函数调用结束，调用是同步完成的（不跨 await），
        // 系统只在调用期间读取它，不保留指针。
        unsafe { options.create_with_security_attributes_raw(pipe_name, &sa as *const _ as *mut std::ffi::c_void) }
    }

    pub async fn bind(path: &Path) -> anyhow::Result<Listener> {
        use anyhow::{Context, bail};
        let name = pipe_name(path);
        let sd = super::sddl::current_user_security_descriptor()?;
        match create_instance(&name, &sd, true) {
            Ok(server) => Ok(Listener { pipe_name: name, sd, next: tokio::sync::Mutex::new(Some(server)) }),
            Err(e) if e.kind() == io::ErrorKind::PermissionDenied || is_pipe_busy(&e) => {
                bail!("another onexd is listening on {name}")
            }
            Err(e) => Err(e).with_context(|| format!("bind {name}"))?,
        }
    }

    fn is_pipe_busy(e: &io::Error) -> bool {
        // ERROR_PIPE_BUSY (231)：已有实例在等待同一个客户端连接上来。
        e.raw_os_error() == Some(231)
    }

    impl Listener {
        /// 等下一个客户端连接。用掉 `bind()` 留下的（或上一次 `accept()` 新建的）实例，
        /// 连接建立后立刻另开一条排队等下一个连接方，复用同一份 ACL。
        pub async fn accept(&self) -> io::Result<Connection> {
            let server = {
                let mut next = self.next.lock().await;
                match next.take() {
                    Some(s) => s,
                    None => create_instance(&self.pipe_name, &self.sd, false)?,
                }
            };
            server.connect().await?;
            let fresh = create_instance(&self.pipe_name, &self.sd, false)?;
            *self.next.lock().await = Some(fresh);
            Ok(Connection::Server(server))
        }
    }

    /// 客户端连接：按 Unix 的习惯把"连接失败"统一报成 `NotFound`，调用方据此提示"onexd 是否在跑"。
    pub async fn connect(path: &Path) -> io::Result<Connection> {
        let name = pipe_name(path);
        // 本机管道随 daemon 一起创建，短暂的 ERROR_PIPE_BUSY（所有实例都在服务别的客户端）重试几次。
        for attempt in 0..5 {
            match named_pipe::ClientOptions::new().open(&name) {
                Ok(client) => return Ok(Connection::Client(client)),
                Err(e) if e.raw_os_error() == Some(231) && attempt < 4 => {
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                }
                Err(e) if e.kind() == io::ErrorKind::NotFound => {
                    return Err(io::Error::new(io::ErrorKind::NotFound, "onexd pipe not found (is onexd running?)"));
                }
                Err(e) => return Err(e),
            }
        }
        Err(io::Error::new(io::ErrorKind::TimedOut, "onexd pipe busy"))
    }

    /// 具名管道没有对应的文件系统路径，关停时无需清理；保留函数签名和 Unix 对齐，调用方不用分叉。
    pub fn cleanup(_path: &Path) {}
}

#[cfg(windows)]
mod sddl {
    //! 用 SDDL 字符串构造安全描述符：`D:` 表示只给自定义 DACL（不继承），`(A;;GA;;;OW)` 表示
    //! 允许（Allow）当前对象所有者（Owner，创建管道的那个用户）完全访问（Generic All）。
    //! 不加任何其它 ACE，等价于"只有当前用户能连"；没有 `AI`（自动继承）标志，不会被容器策略放宽。
    //!
    //! 这里只返回安全描述符的原始字节（`Vec<u8>`，普通堆内存，`Send`，可以安全跨 `.await` 持有）；
    //! 包这层字节的 `SECURITY_ATTRIBUTES`（含裸指针，非 `Send`）由调用方在每次 FFI 调用前现场拼，
    //! 不作为长期持有的字段，见 `windows_impl::create_instance`。
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };

    const SDDL_OWNER_FULL_CONTROL_ONLY: &str = "D:(A;;GA;;;OW)";

    pub(super) fn current_user_security_descriptor() -> anyhow::Result<Vec<u8>> {
        let wide: Vec<u16> = OsStr::new(SDDL_OWNER_FULL_CONTROL_ONLY).encode_wide().chain(Some(0)).collect();
        let mut sd_ptr: *mut std::ffi::c_void = std::ptr::null_mut();
        let mut sd_len: u32 = 0;
        // SAFETY: `wide` 是一个有效的、以 NUL 结尾的宽字符串；成功时系统在 `sd_ptr` 分配一块缓冲区，
        // 大小写进 `sd_len`，所有权转给调用方，用 `LocalFree` 释放（这里转存成 `Vec<u8>` 后立即释放，
        // 不保留原始指针）。
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide.as_ptr(),
                SDDL_REVISION_1,
                &mut sd_ptr,
                &mut sd_len,
            )
        };
        anyhow::ensure!(ok != 0, "ConvertStringSecurityDescriptorToSecurityDescriptorW failed");
        let sd = unsafe { std::slice::from_raw_parts(sd_ptr as *const u8, sd_len as usize).to_vec() };
        // SAFETY: `sd_ptr` 是上面成功调用分配的、尚未释放的内存，`LocalFree` 的 HANDLE 参数
        // （windows-sys 0.59 里是 `*mut c_void`）接受任何本地内存分配返回的指针。
        unsafe { LocalFree(sd_ptr) };
        Ok(sd)
    }
}
