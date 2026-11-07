// calmdev on the desktop (docs/desktop.md): one window on http://localhost:<port>.
// At launch, when nothing answers on the port, the app starts ./run.sh of the repository and shows the splash
// (../splash) until the server answers; on failure the splash says what to do. On exit it stops only the server it
// started itself. Settings: calmdev.json (built in), then <app config dir>/config.json, then PORT.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::UpdaterExt;

const DEFAULTS: &str = include_str!("../calmdev.json");
/// The value of plugins.updater.pubkey in tauri.conf.json until the developer has generated the update key
/// (docs/desktop.md, « Publier une version »). While it is there, the app never looks for an update.
const UPDATER_PLACEHOLDER: &str = "PLACEHOLDER_UPDATER_PUBLIC_KEY";
const LOCAL_HOSTS: [&str; 3] = ["localhost", "127.0.0.1", "[::1]"];

/// The server this app started, if any: the only one it stops.
struct Server(Mutex<Option<Child>>);

struct Settings {
    port: u16,
    repo: PathBuf,
    wait: Duration,
    config_file: PathBuf,
}

fn settings(app: &AppHandle) -> Settings {
    let defaults: Value = serde_json::from_str(DEFAULTS).unwrap_or(Value::Null);
    let config_file = app
        .path()
        .app_config_dir()
        .map(|d| d.join("config.json"))
        .unwrap_or_else(|_| PathBuf::from("config.json"));
    let user: Value = fs::read_to_string(&config_file)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null);
    let get = |key: &str| -> Option<Value> {
        user.get(key)
            .filter(|v| !v.is_null())
            .or_else(|| defaults.get(key))
            .cloned()
    };
    let port = std::env::var("PORT")
        .ok()
        .and_then(|p| p.trim().parse::<u16>().ok())
        .or_else(|| get("port").and_then(|v| v.as_u64()).and_then(|p| u16::try_from(p).ok()))
        .unwrap_or(3078);
    // Default repository: the parent folder of desktop/ (this file is desktop/src-tauri/src/main.rs)
    let repo = get("repo")
        .and_then(|v| v.as_str().map(str::to_owned))
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join(".."));
    let repo = repo.canonicalize().unwrap_or(repo);
    let wait = Duration::from_secs(get("waitSeconds").and_then(|v| v.as_u64()).unwrap_or(60));
    Settings { port, repo, wait, config_file }
}

fn server_url(port: u16) -> String {
    format!("http://localhost:{port}")
}

/// The first page: the guard link the server wrote (docs/gate.md), so the window gets the guard cookie and can act;
/// without it, the plain address (every action would answer 403). Same folder as lib/gate.mjs: CALMDEV_GUARD_DIR,
/// ESCADRILLE_GUARD_DIR, ~/.config/calmdev, then the old ~/.config/escadrille. The key is never logged.
fn first_url(port: u16) -> String {
    let base = server_url(port);
    let home = std::env::var("HOME").map(PathBuf::from).unwrap_or_default();
    let dirs: Vec<PathBuf> = ["CALMDEV_GUARD_DIR", "ESCADRILLE_GUARD_DIR"]
        .iter()
        .filter_map(|k| std::env::var(k).ok().filter(|v| !v.is_empty()).map(PathBuf::from))
        .chain([home.join(".config/calmdev"), home.join(".config/escadrille")])
        .collect();
    let prefix = format!("{base}/guard?k=");
    dirs.iter()
        .filter_map(|d| fs::read_to_string(d.join("guard-link")).ok())
        .filter_map(|t| t.lines().next().map(|l| l.trim().to_owned()))
        .find(|l| l.starts_with(&prefix) && l.len() > prefix.len())
        .unwrap_or(base)
}

fn answers(port: u16) -> bool {
    let addrs: [SocketAddr; 2] = [([127, 0, 0, 1], port).into(), (std::net::Ipv6Addr::LOCALHOST, port).into()];
    addrs
        .iter()
        .any(|a| TcpStream::connect_timeout(a, Duration::from_millis(300)).is_ok())
}

fn is_local(url: &Url) -> bool {
    url.scheme() == "tauri"
        || (matches!(url.scheme(), "http" | "ws") && url.host_str().is_some_and(|h| LOCAL_HOSTS.contains(&h)))
}

/// Starts ./run.sh in a login shell (an app opened from the Finder has no PATH to node), output in the log file.
fn start(s: &Settings, log: &Path) -> Result<Child, String> {
    if !s.repo.join("run.sh").is_file() {
        return Err(format!(
            "Aucun run.sh dans {} : écrivez le dossier du dépôt dans `{}` (« repo »), puis rouvrez calmdev.",
            s.repo.display(),
            s.config_file.display()
        ));
    }
    if let Some(dir) = log.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let out = fs::File::create(log).map_err(|e| format!("Journal impossible à écrire ({e}) : lancez `./run.sh` dans {}.", s.repo.display()))?;
    let err = out.try_clone().map_err(|e| e.to_string())?;
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    Command::new(shell)
        .args(["-l", "-i", "-c", "exec ./run.sh"])
        .current_dir(&s.repo)
        .env("PORT", s.port.to_string())
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(err)
        .spawn()
        .map_err(|e| format!("run.sh ne démarre pas ({e}) : lancez `./run.sh` dans {}, puis rouvrez calmdev.", s.repo.display()))
}

fn fail(window: &WebviewWindow, detail: &str) {
    // the splash may still be loading when the failure is immediate
    thread::sleep(Duration::from_millis(400));
    let js = format!(
        "window.calmdevFail && window.calmdevFail({}, {})",
        Value::from("calmdev ne démarre pas"),
        Value::from(detail)
    );
    let _ = window.eval(&js);
}

/// True once tauri.conf.json carries a real public key: the updater plugin then checks the minisign signature of
/// every update with it. With the placeholder (or nothing), no check is made and the plugin is not even loaded.
fn updater_enabled(app: &AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|c| c.get("pubkey"))
        .and_then(|k| k.as_str())
        .map(str::trim)
        .is_some_and(|k| !k.is_empty() && !k.starts_with(UPDATER_PLACEHOLDER))
}

/// In the background, after the page is open: asks the release endpoint for a newer version and, if there is one,
/// shows a native « Mettre à jour / Plus tard » box. « Mettre à jour » downloads, verifies, installs and relaunches.
/// A failed check (offline, no release yet) is logged and otherwise ignored.
fn check_for_update(app: &AppHandle) {
    if !updater_enabled(app) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = offer_update(&app).await {
            eprintln!("calmdev: update check failed: {e}");
        }
    });
}

async fn offer_update(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let Some(update) = app.updater()?.check().await? else { return Ok(()) };
    let ask = app
        .dialog()
        .message(format!(
            "calmdev {} est disponible (version installée : {}).",
            update.version, update.current_version
        ))
        .title("Mise à jour de calmdev")
        .buttons(MessageDialogButtons::OkCancelCustom("Mettre à jour".into(), "Plus tard".into()));
    // the box blocks its thread until the answer: never the main thread, never the async executor
    if !tauri::async_runtime::spawn_blocking(move || ask.blocking_show()).await? {
        return Ok(());
    }
    update.download_and_install(|_, _| {}, || {}).await?;
    stop(app);
    app.restart()
}

/// Waits for the server (starting it when nothing answers), then opens it in the window.
fn boot(app: AppHandle, window: WebviewWindow) {
    let s = settings(&app);
    let log = app
        .path()
        .app_log_dir()
        .map(|d| d.join("server.log"))
        .unwrap_or_else(|_| s.repo.join("calmdev-desktop.log"));
    if !answers(s.port) {
        match start(&s, &log) {
            Ok(child) => *app.state::<Server>().0.lock().unwrap() = Some(child),
            Err(why) => return fail(&window, &why),
        }
        let since = Instant::now();
        while !answers(s.port) {
            let exited = app
                .state::<Server>()
                .0
                .lock()
                .unwrap()
                .as_mut()
                .is_some_and(|c| matches!(c.try_wait(), Ok(Some(_))));
            if exited {
                return fail(&window, &format!(
                    "Le serveur s’est arrêté : lisez `{}` ou lancez `./run.sh` dans {}, puis rouvrez calmdev.",
                    log.display(), s.repo.display()
                ));
            }
            if since.elapsed() > s.wait {
                return fail(&window, &format!(
                    "Rien ne répond sur le port {} après {} s : lisez `{}` ou lancez `./run.sh` dans {}, puis rouvrez calmdev.",
                    s.port, s.wait.as_secs(), log.display(), s.repo.display()
                ));
            }
            thread::sleep(Duration::from_millis(250));
        }
    }
    match first_url(s.port).parse::<Url>() {
        Ok(url) => {
            match window.navigate(url) {
                Ok(()) => check_for_update(&app),
                Err(e) => fail(&window, &format!("La page ne s’ouvre pas ({e}) : ouvrez {} dans un navigateur.", server_url(s.port))),
            }
        }
        Err(e) => fail(&window, &format!("Adresse invalide ({e}) : vérifiez « port » dans `{}`.", s.config_file.display())),
    }
}

/// Stops the server this app started (TERM to run.sh, which stops node), never one it found running.
fn stop(app: &AppHandle) {
    let Some(mut child) = app.state::<Server>().0.lock().unwrap().take() else { return };
    if matches!(child.try_wait(), Ok(Some(_))) {
        return;
    }
    let _ = Command::new("/bin/kill").args(["-TERM", &child.id().to_string()]).status();
    let since = Instant::now();
    while since.elapsed() < Duration::from_secs(5) {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn main() {
    let app = tauri::Builder::default()
        .manage(Server(Mutex::new(None)))
        .setup(|app| {
            if updater_enabled(app.handle()) {
                app.handle().plugin(tauri_plugin_dialog::init())?;
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            let conf = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")
                .cloned()
                .expect("tauri.conf.json: the window labelled main");
            let window = WebviewWindowBuilder::from_config(app.handle(), &conf)?
                // only localhost opens in the window; any other link goes to the default browser
                .on_navigation(|url| {
                    if is_local(url) {
                        return true;
                    }
                    if matches!(url.scheme(), "http" | "https" | "mailto") {
                        let _ = Command::new("/usr/bin/open").arg(url.as_str()).spawn();
                    }
                    false
                })
                .build()?;
            let handle = app.handle().clone();
            thread::spawn(move || boot(handle, window));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("calmdev: the app does not build");
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            stop(handle);
        }
    });
}
