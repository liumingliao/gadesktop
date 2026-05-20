//! B4 M2 tray-mode spike (2026-05-20).
//!
//! Validates: tray icon registration / window close → hide / tray Show
//! restore / tray Quit true-exit / WebView keep-alive while hidden.
//! See `../README.md` validation checklist T1-T16 (T17-T19 App Nap
//! deferred to separate probe — see README "After-experiment" section).
//!
//! Heartbeat fires on a dedicated `std::thread` (not async) to keep
//! the spike's dep footprint minimal and predictable: spawned via
//! `app_handle.emit` from native thread — Tauri's emit is `Send`.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, WindowEvent,
};

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // -------- Build tray menu (T1-T4) --------
            let show = MenuItem::with_id(app, "show", "Show Galley", true, None::<&str>)?;
            let status = MenuItem::with_id(
                app,
                "status",
                "1 active · 0 idle (spike — fake)",
                false,
                None::<&str>,
            )?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Galley", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &status, &separator, &quit])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        eprintln!("[m2-spike] tray menu Show clicked");
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => {
                        eprintln!("[m2-spike] tray menu Quit clicked → app.exit(0)");
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            // -------- Window close → hide (T5-T8) --------
            let main_window = app
                .get_webview_window("main")
                .expect("main window must exist");
            let w_clone = main_window.clone();
            main_window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    eprintln!("[m2-spike] window close intercepted → hide()");
                    api.prevent_close();
                    let _ = w_clone.hide();
                }
            });

            // -------- Heartbeat timer (T13-T16) on native thread --------
            //
            // Plain `std::thread` + `std::thread::sleep` to avoid pulling
            // a tokio runtime into the spike. Tauri's `emit` is `Send`
            // so this is safe.
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                let mut counter: u64 = 0;
                let start = std::time::Instant::now();
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    counter += 1;
                    let _ = app_handle.emit("heartbeat", counter);
                    if counter.is_multiple_of(10) {
                        eprintln!(
                            "[m2-spike] heartbeat #{counter} at t+{:.1}s",
                            start.elapsed().as_secs_f64()
                        );
                    }
                }
            });

            // Inform JS that App Nap defeat is deferred (UI still shows
            // the row).
            let _ = app.emit("app-nap-status", "deferred (T17-T19 separate)".to_string());

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
