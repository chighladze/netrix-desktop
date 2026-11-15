use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use uuid::Uuid;

fn terminal_route(
    source: &str,
    handoff_id: &str,
    target_label: &str,
    origin_tab_id: &str,
) -> Result<String, String> {
    if source != "main" && (!source.starts_with("detached-") || source.starts_with("detached-map-"))
    {
        return Err("Only terminal windows can open a floating terminal".into());
    }
    Uuid::parse_str(handoff_id).map_err(|_| "Invalid terminal handoff ID")?;
    let target_id = target_label
        .strip_prefix("detached-terminal-")
        .ok_or("Invalid floating terminal label")?;
    let parsed = Uuid::parse_str(target_id).map_err(|_| "Invalid floating terminal label")?;
    if parsed.to_string() != target_id || origin_tab_id.len() > 160 {
        return Err("Invalid floating terminal routing".into());
    }
    let mut route =
        tauri::Url::parse("tauri://localhost/index.html").map_err(|error| error.to_string())?;
    route
        .query_pairs_mut()
        .append_pair("detached", "true")
        .append_pair("handoff", handoff_id)
        .append_pair("source", source)
        .append_pair("originTabId", origin_tab_id);
    Ok(format!(
        "index.html?{}",
        route.query().ok_or("Missing terminal route")?
    ))
}

/// Fixed-purpose window creation for extracting a terminal pane or group tab. The caller cannot
/// choose a URL, capabilities, source identity, credentials or another window.
#[tauri::command]
pub async fn open_terminal_window(
    window: WebviewWindow,
    handoff_id: String,
    target_label: String,
    origin_tab_id: String,
    title: String,
    drop_point: Option<crate::terminal_drag::DragPoint>,
    workspace: Option<bool>,
) -> Result<(), String> {
    let mut route = terminal_route(window.label(), &handoff_id, &target_label, &origin_tab_id)?;
    if workspace.unwrap_or(false) {
        route.push_str("&workspace=true");
    }
    let app = window.app_handle();
    if app.get_webview_window(&target_label).is_some() {
        return Err("The floating terminal already exists".into());
    }
    let mut point = if let Some(point) = drop_point {
        tauri::PhysicalPosition::new(f64::from(point.x), f64::from(point.y))
    } else {
        window
            .cursor_position()
            .map_err(|error| error.to_string())?
    };
    let mut monitor = window
        .monitor_from_point(point.x, point.y)
        .map_err(|error| error.to_string())?;
    // A monitor may have disconnected during screen preparation. Keep the new
    // window visible rather than trusting an obsolete off-screen drop point.
    if monitor.is_none() {
        point = window
            .cursor_position()
            .map_err(|error| error.to_string())?;
        monitor = window
            .monitor_from_point(point.x, point.y)
            .map_err(|error| error.to_string())?;
    }
    let scale = monitor
        .as_ref()
        .map(|monitor| monitor.scale_factor())
        .unwrap_or(1.0);
    let (width, height, x, y) = if let Some(monitor) = &monitor {
        let area = monitor.work_area();
        let width = (f64::from(area.size.width) / scale - 24.0)
            .floor()
            .clamp(1.0, 1000.0);
        let height = (f64::from(area.size.height) / scale - 24.0)
            .floor()
            .clamp(1.0, 700.0);
        let left = f64::from(area.position.x);
        let top = f64::from(area.position.y);
        let x = (point.x - width * scale * 0.25).round().clamp(
            left,
            (left + f64::from(area.size.width) - width * scale).max(left),
        );
        let y = (point.y - 18.0 * scale).round().clamp(
            top,
            (top + f64::from(area.size.height) - height * scale).max(top),
        );
        (width, height, x, y)
    } else {
        (1000.0, 700.0, point.x - 250.0, point.y - 18.0)
    };
    let title: String = title
        .chars()
        .filter(|character| !character.is_control())
        .take(120)
        .collect();
    let target = WebviewWindowBuilder::new(app, &target_label, WebviewUrl::App(route.into()))
        .title(format!("Terminal - {title}"))
        .inner_size(width, height)
        .min_inner_size(width.min(640.0), height.min(400.0))
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .visible(false)
        .focused(false)
        .build()
        .map_err(|error| error.to_string())?;
    if let Err(error) = target.set_position(tauri::PhysicalPosition::new(x as i32, y as i32)) {
        let _ = target.destroy();
        return Err(error.to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::terminal_route;
    const ID: &str = "2ec057a5-09f1-43dd-99bd-d10d464516fc";

    #[test]
    fn extracted_windows_have_fixed_routes_and_encoded_identifiers() {
        let route = terminal_route(
            "detached-group",
            ID,
            &format!("detached-terminal-{ID}"),
            "tab-&source=main",
        )
        .expect("route");
        let url = tauri::Url::parse("tauri://localhost/")
            .expect("base")
            .join(&route)
            .expect("url");
        let pairs: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(url.path(), "/index.html");
        assert_eq!(pairs.len(), 4);
        assert_eq!(pairs["source"], "detached-group");
        assert_eq!(pairs["originTabId"], "tab-&source=main");
        assert_eq!(pairs["detached"], "true");
        assert!(terminal_route("main", ID, "main", "tab").is_err());
        assert!(terminal_route(
            "detached-map-1",
            ID,
            &format!("detached-terminal-{ID}"),
            "tab"
        )
        .is_err());
        assert!(terminal_route(
            "tab-preview-1",
            ID,
            &format!("detached-terminal-{ID}"),
            "tab"
        )
        .is_err());
        assert!(terminal_route("main", "bad", &format!("detached-terminal-{ID}"), "tab").is_err());
    }

    #[test]
    fn pane_extraction_does_not_grant_generic_webview_creation() {
        let detached = include_str!("../capabilities/detached-terminal.json");
        assert!(detached.contains("allow-open-terminal-window"));
        assert!(!detached.contains("allow-create-webview-window"));
        assert!(!include_str!("../capabilities/detached-map.json")
            .contains("allow-open-terminal-window"));
    }
}
