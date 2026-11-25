//! 本机 IPC 的传输层：Unix 用 socket 文件，Windows 用具名管道。两边都是同一套按行分隔的
//! JSON 协议（见 `ipc` 模块），这里只封装"怎么建连接、怎么等下一个连接"，行协议本身不在这里。
//!
//! Windows 管道只允许当前进程 TokenUser 的 SID，并拒绝远程客户端。客户端在发送任何协议消息前
//! 查询已打开管道的所有者，防止同名管道替代本机 daemon。

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

        #[cfg(target_os = "macos")]
        pub(crate) fn peer_pid(&self) -> io::Result<u32> {
            use std::os::fd::AsRawFd;

            let mut pid: libc::pid_t = 0;
            let mut len = size_of::<libc::pid_t>() as libc::socklen_t;
            // The output pointer is writable for the exact size advertised to the kernel.
            let result = unsafe {
                libc::getsockopt(
                    self.0.as_raw_fd(),
                    libc::SOL_LOCAL,
                    libc::LOCAL_PEERPID,
                    (&mut pid as *mut libc::pid_t).cast(),
                    &mut len,
                )
            };
            if result != 0 {
                return Err(io::Error::last_os_error());
            }
            if pid <= 0 || len as usize != size_of::<libc::pid_t>() {
                return Err(io::Error::other("could not identify the local socket peer"));
            }
            Ok(pid as u32)
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
    use std::os::windows::io::AsRawHandle;
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
        sd: Vec<u32>,
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
    fn create_instance(pipe_name: &str, sd: &[u32], first: bool) -> io::Result<named_pipe::NamedPipeServer> {
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

    /// 连接并验证该实例的所有者，调用者拿到句柄之后才会发送请求。
    pub async fn connect(path: &Path) -> io::Result<Connection> {
        let name = pipe_name(path);
        let owner_sid = super::sddl::current_user_sid()?;
        // 本机管道随 daemon 一起创建，短暂的 ERROR_PIPE_BUSY（所有实例都在服务别的客户端）重试几次。
        for attempt in 0..5 {
            match named_pipe::ClientOptions::new().open(&name) {
                Ok(client) => {
                    super::sddl::verify_pipe_owner(client.as_raw_handle(), &owner_sid)?;
                    return Ok(Connection::Client(client));
                }
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
    use std::ffi::c_void;
    use std::io;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::ptr::{NonNull, null_mut};

    use windows_sys::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, HANDLE, LocalFree};
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo, SDDL_REVISION_1,
        SE_KERNEL_OBJECT,
    };
    use windows_sys::Win32::Security::{
        GetTokenInformation, OWNER_SECURITY_INFORMATION, PSID, TOKEN_QUERY, TOKEN_USER, TokenUser,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    /// Owns an allocation returned by the security APIs, which must be freed with LocalFree.
    struct LocalAllocation(NonNull<c_void>);

    impl LocalAllocation {
        fn new(ptr: *mut c_void) -> io::Result<Self> {
            NonNull::new(ptr)
                .map(Self)
                .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing Windows security data"))
        }
    }

    impl Drop for LocalAllocation {
        fn drop(&mut self) {
            // SAFETY: only successful allocating Windows security APIs provide this pointer.
            unsafe {
                LocalFree(self.0.as_ptr());
            }
        }
    }

    pub(super) fn current_user_sid() -> io::Result<String> {
        let mut token = null_mut();
        // SAFETY: GetCurrentProcess returns a pseudo-handle; OpenProcessToken initializes the out handle.
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: OpenProcessToken transferred ownership of the returned real handle.
        let token = unsafe { OwnedHandle::from_raw_handle(token) };
        let handle = token.as_raw_handle();
        let mut required = 0;
        // SAFETY: a null buffer with length zero asks Windows for the required size.
        if unsafe { GetTokenInformation(handle, TokenUser, null_mut(), 0, &mut required) } != 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "unexpected empty Windows token user data"));
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(ERROR_INSUFFICIENT_BUFFER as i32) {
            return Err(error);
        }
        if (required as usize) < std::mem::size_of::<TOKEN_USER>() {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "short Windows token user data"));
        }
        // TOKEN_USER contains a pointer, so preserve pointer alignment in the caller-owned buffer.
        let mut buffer = vec![0usize; (required as usize).div_ceil(std::mem::size_of::<usize>())];
        let mut returned = 0;
        // SAFETY: buffer is aligned and has at least required writable bytes.
        if unsafe { GetTokenInformation(handle, TokenUser, buffer.as_mut_ptr().cast(), required, &mut returned) } == 0 {
            return Err(io::Error::last_os_error());
        }
        if (returned as usize) < std::mem::size_of::<TOKEN_USER>() {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "short Windows token user data"));
        }
        // SAFETY: Windows filled the TOKEN_USER and its SID; the buffer stays alive through conversion.
        let sid = unsafe { (*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid };
        sid_string(sid)
    }

    fn sid_string(sid: PSID) -> io::Result<String> {
        if sid.is_null() {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "missing Windows security identifier"));
        }
        let mut wide = null_mut();
        // SAFETY: callers pass a Windows-provided SID valid for the entire call.
        if unsafe { ConvertSidToStringSidW(sid, &mut wide) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let _allocation = LocalAllocation::new(wide.cast())?;
        // SAFETY: success returns a NUL-terminated UTF-16 SID string in that allocation.
        let value = unsafe {
            let mut len = 0;
            while *wide.add(len) != 0 {
                len += 1;
            }
            std::slice::from_raw_parts(wide, len)
        };
        String::from_utf16(value).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
    }

    pub(super) fn current_user_security_descriptor() -> io::Result<Vec<u32>> {
        let sid = current_user_sid()?;
        let wide: Vec<u16> = format!("O:{sid}D:P(A;;GA;;;{sid})").encode_utf16().chain(Some(0)).collect();
        let mut descriptor = null_mut();
        let mut len = 0;
        // SAFETY: SDDL is a valid NUL-terminated string; Windows initializes descriptor and length on success.
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                &mut len,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let allocation = LocalAllocation::new(descriptor)?;
        if len == 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "empty Windows pipe security descriptor"));
        }
        // SDDL conversion returns a self-relative descriptor with DWORD offsets. Keep its alignment
        // when copying it into Rust-owned data so no raw pointer lives across an await point.
        let mut aligned = vec![0u32; (len as usize).div_ceil(std::mem::size_of::<u32>())];
        // SAFETY: Windows initialized len bytes, and aligned has enough room for them.
        unsafe {
            std::ptr::copy_nonoverlapping(
                allocation.0.as_ptr().cast::<u8>(),
                aligned.as_mut_ptr().cast::<u8>(),
                len as usize,
            );
        }
        Ok(aligned)
    }

    pub(super) fn verify_pipe_owner(handle: HANDLE, expected_sid: &str) -> io::Result<()> {
        let mut owner = null_mut();
        let mut descriptor = null_mut();
        // SAFETY: the open named-pipe handle remains live; Windows supplies the owner within the
        // allocated descriptor. Convert it before freeing the descriptor.
        let status = unsafe {
            GetSecurityInfo(
                handle,
                SE_KERNEL_OBJECT,
                OWNER_SECURITY_INFORMATION,
                &mut owner,
                null_mut(),
                null_mut(),
                null_mut(),
                &mut descriptor,
            )
        };
        if status != 0 {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        let _descriptor = LocalAllocation::new(descriptor)?;
        if sid_string(owner)? != expected_sid {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "onexd pipe owner is not the current Windows user",
            ));
        }
        Ok(())
    }
}
