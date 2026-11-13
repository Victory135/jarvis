// Desktop shell: system tray, hide-to-tray, and the floating mini orb window.
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, Window, WindowEvent};

const ORB: &str = "orb";
const ORB_W: f64 = 168.0;
const ORB_H: f64 = 196.0;

pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show HUD", true, None::<&str>)?;
    let orb = MenuItem::with_id(app, "orb", "Mini orb on / off", true, None::<&str>)?;
    let mute = MenuItem::with_id(app, "mute", "Privacy mute on / off", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit JARVIS", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &orb, &mute, &sep, &quit])?;

    let mut tray = TrayIconBuilder::with_id("jarvis")
        .tooltip("J.A.R.V.I.S. (local fan build)")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id.as_ref() {
            "show" => show_main(app),
            "orb" => { let _ = toggle_orb_inner(app); }
            "mute" => { let _ = app.emit_to("main", "tray", "mute"); }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// Closing the HUD hides it to the tray; "Quit JARVIS" in the tray menu exits.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    match event {
        WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
            api.prevent_close();
            let _ = window.hide();
            // WebView2 still reports a hidden window as visible, so tell the page to stop animating.
            let _ = window.emit_to("main", "tray", "hidden");
        }
        // However the orb closes (its button, the tray, Alt+F4), the HUD's ORB button stays in sync.
        WindowEvent::Destroyed if window.label() == ORB => {
            let _ = window.emit_to("main", "orb", false);
        }
        _ => {}
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.emit_to("main", "tray", "shown");
    }
}

fn toggle_orb_inner(app: &AppHandle) -> tauri::Result<bool> {
    if let Some(w) = app.get_webview_window(ORB) {
        // Closing (not hiding) frees the orb's webview process and memory.
        w.close()?; // the Destroyed event notifies the HUD
        return Ok(false);
    }
    let mut b = WebviewWindowBuilder::new(app, ORB, WebviewUrl::App("orb.html".into()))
        .title("JARVIS orb")
        .inner_size(ORB_W, ORB_H)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false);
    // Bottom-right corner of the primary screen's work area (above the taskbar).
    if let Ok(Some(m)) = app.primary_monitor() {
        let sf = m.scale_factor();
        let wa = m.work_area();
        let x = (wa.position.x as f64 + wa.size.width as f64) / sf - ORB_W - 24.0;
        let y = (wa.position.y as f64 + wa.size.height as f64) / sf - ORB_H - 24.0;
        b = b.position(x, y);
    }
    b.build()?;
    let _ = app.emit_to("main", "orb", true);
    Ok(true)
}

// Must be async: creating a window from a synchronous command deadlocks on Windows.
#[tauri::command]
pub async fn toggle_orb(app: AppHandle) -> Result<bool, String> {
    toggle_orb_inner(&app).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn show_hud(app: AppHandle) {
    show_main(&app);
}

#[tauri::command]
pub fn orb_is_open(app: AppHandle) -> bool {
    app.get_webview_window(ORB).is_some()
}
