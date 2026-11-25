#[test]
fn reports_build_version_without_creating_daemon_state() {
    let directory = tempfile::tempdir().unwrap();
    let home = directory.path().join("one-x-state");
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_onexd"))
        .arg("--version")
        .env("ONEX_HOME", &home)
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(String::from_utf8(output.stdout).unwrap().trim(), format!("onexd {}", onexd::BUILD_VERSION));
    assert!(!home.exists());
}
