//! The native menu bar (macOS). The page owns what the menus contain: it sends a snapshot of them, every label,
//! shortcut and enabled or checked state, whenever something changes, and this builds a real menu from it. A click
//! sends the item's id back to the page (the `native-menu` event), which runs the command, so there is one list of
//! commands and one place that decides what each does.
//!
//! The standard app items (About, Hide, Quit) and the Window menu are added here. Cut, Copy and Paste are system
//! items, because the editor has to receive them as real clipboard events.

use serde::Deserialize;
use tauri::menu::{CheckMenuItemBuilder, IsMenuItem, Menu, MenuItemBuilder, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Runtime};

#[derive(Deserialize, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Entry {
    Separator,
    #[serde(rename_all = "camelCase")]
    Item {
        id: String,
        label: String,
        accelerator: Option<String>,
        enabled: bool,
        /// Present for a check or radio item.
        checked: Option<bool>,
        /// A system item the page leaves to the system: "cut", "copy", "paste" or "selectAll".
        role: Option<String>,
        /// Belongs in the app menu (Settings, ⌘,) instead of the menu the page listed it in.
        app_menu: Option<bool>,
    },
    Submenu {
        label: String,
        enabled: bool,
        items: Vec<Entry>,
    },
}

#[derive(Deserialize, Debug)]
pub struct Top {
    pub label: String,
    pub items: Vec<Entry>,
}

/// The first item the page marked for the app menu.
fn find_app_item(items: &[Entry]) -> Option<&Entry> {
    items.iter().find_map(|entry| match entry {
        Entry::Item { app_menu: Some(true), .. } => Some(entry),
        Entry::Submenu { items, .. } => find_app_item(items),
        _ => None,
    })
}

fn append_all<R: Runtime>(app: &AppHandle<R>, into: &Submenu<R>, items: &[Entry]) -> tauri::Result<()> {
    for entry in items {
        match entry {
            Entry::Separator => into.append(&PredefinedMenuItem::separator(app)?)?,
            Entry::Submenu { label, enabled, items } => {
                let sub = Submenu::new(app, label, *enabled)?;
                append_all(app, &sub, items)?;
                into.append(&sub)?;
            }
            Entry::Item { app_menu: Some(true), .. } => {}
            Entry::Item { id, label, accelerator, enabled, checked, role, .. } => {
                if let Some(role) = role {
                    let label = Some(label.as_str());
                    let item = match role.as_str() {
                        "cut" => Some(PredefinedMenuItem::cut(app, label)?),
                        "copy" => Some(PredefinedMenuItem::copy(app, label)?),
                        "paste" => Some(PredefinedMenuItem::paste(app, label)?),
                        "selectAll" => Some(PredefinedMenuItem::select_all(app, label)?),
                        _ => None,
                    };
                    if let Some(item) = item {
                        into.append(&item)?;
                        continue;
                    }
                }
                // A shortcut the system cannot parse must not lose the item: it is added without it.
                let item: Box<dyn IsMenuItem<R>> = match checked {
                    Some(checked) => {
                        let build = |accelerator: Option<&String>| {
                            let mut b = CheckMenuItemBuilder::with_id(id.as_str(), label).enabled(*enabled).checked(*checked);
                            if let Some(a) = accelerator {
                                b = b.accelerator(a);
                            }
                            b.build(app)
                        };
                        Box::new(build(accelerator.as_ref()).or_else(|_| build(None))?)
                    }
                    None => {
                        let build = |accelerator: Option<&String>| {
                            let mut b = MenuItemBuilder::with_id(id.as_str(), label).enabled(*enabled);
                            if let Some(a) = accelerator {
                                b = b.accelerator(a);
                            }
                            b.build(app)
                        };
                        Box::new(build(accelerator.as_ref()).or_else(|_| build(None))?)
                    }
                };
                into.append(item.as_ref())?;
            }
        }
    }
    Ok(())
}

/// The whole bar: the app menu, then the page's menus, then Window.
pub fn build<R: Runtime>(app: &AppHandle<R>, tops: &[Top]) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;

    let name = app.package_info().name.clone();
    let application = Submenu::new(app, &name, true)?;
    application.append(&PredefinedMenuItem::about(app, None, None)?)?;
    application.append(&PredefinedMenuItem::separator(app)?)?;
    if let Some(Entry::Item { id, label, accelerator, enabled, .. }) = tops.iter().find_map(|top| find_app_item(&top.items)) {
        let build = |accelerator: Option<&String>| {
            let mut b = MenuItemBuilder::with_id(id.as_str(), label).enabled(*enabled);
            if let Some(a) = accelerator {
                b = b.accelerator(a);
            }
            b.build(app)
        };
        application.append(&build(accelerator.as_ref()).or_else(|_| build(None))?)?;
        application.append(&PredefinedMenuItem::separator(app)?)?;
    }
    #[cfg(target_os = "macos")]
    {
        application.append(&PredefinedMenuItem::services(app, None)?)?;
        application.append(&PredefinedMenuItem::separator(app)?)?;
    }
    application.append(&PredefinedMenuItem::hide(app, None)?)?;
    #[cfg(target_os = "macos")]
    application.append(&PredefinedMenuItem::hide_others(app, None)?)?;
    #[cfg(target_os = "macos")]
    application.append(&PredefinedMenuItem::show_all(app, None)?)?;
    application.append(&PredefinedMenuItem::separator(app)?)?;
    application.append(&PredefinedMenuItem::quit(app, None)?)?;
    menu.append(&application)?;

    for top in tops {
        let submenu = Submenu::new(app, &top.label, true)?;
        append_all(app, &submenu, &top.items)?;
        menu.append(&submenu)?;
    }

    let window = Submenu::new(app, "Window", true)?;
    window.append(&PredefinedMenuItem::minimize(app, None)?)?;
    window.append(&PredefinedMenuItem::maximize(app, None)?)?;
    menu.append(&window)?;
    #[cfg(target_os = "macos")]
    window.set_as_windows_menu_for_nsapp()?;
    Ok(menu)
}

/// Replaces the menu bar with one built from the page's snapshot.
#[tauri::command]
pub fn set_native_menu<R: Runtime>(app: AppHandle<R>, menus: Vec<Top>) -> Result<(), String> {
    let menu = build(&app, &menus).map_err(|e| e.to_string())?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_snapshot_from_the_page_parses() {
        let json = r#"[{"label":"File","items":[
            {"kind":"item","id":"n1","label":"New","accelerator":"Cmd+N","enabled":true},
            {"kind":"separator"},
            {"kind":"item","id":"n2","label":"Bold","enabled":false,"checked":true},
            {"kind":"item","id":"n3","label":"Copy","enabled":true,"role":"copy"},
            {"kind":"submenu","label":"Open Recent","enabled":true,"items":[{"kind":"item","id":"n4","label":"a.md","enabled":true}]}
        ]}]"#;
        let tops: Vec<Top> = serde_json::from_str(json).unwrap();
        assert_eq!(tops.len(), 1);
        assert_eq!(tops[0].items.len(), 5);
        match &tops[0].items[1] {
            Entry::Separator => {}
            other => panic!("{other:?}"),
        }
        match &tops[0].items[2] {
            Entry::Item { checked, enabled, .. } => assert_eq!((*checked, *enabled), (Some(true), false)),
            other => panic!("{other:?}"),
        }
    }
}
