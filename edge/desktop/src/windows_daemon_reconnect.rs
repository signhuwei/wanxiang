use std::path::Path;

use onex_core::daemon::{stop_windows_for_reconnect, wait_for_device, wait_for_device_info};

use crate::bridge::{ErrorBody, reconnect_busy, reconnect_failed};

pub(crate) async fn restart(socket: &Path, device: Option<&str>, force: bool) -> Result<(), ErrorBody> {
    match stop_windows_for_reconnect(socket, device, force).await {
        Ok(true) => {}
        Ok(false) => return Err(reconnect_busy()),
        Err(error) => {
            tracing::warn!(%error, "could not stop the installed Windows daemon for reconnect");
            return Err(reconnect_failed());
        }
    }
    let ready = match device {
        Some(id) => wait_for_device(socket, id).await,
        None => wait_for_device_info(socket, None).await.is_some(),
    };
    if !ready {
        return Err(reconnect_failed());
    }
    Ok(())
}
