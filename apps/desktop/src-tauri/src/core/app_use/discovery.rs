// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AdapterInstallStatus {
    pub installed: bool,
    pub evidence: Option<String>,
}

pub trait RegistryReader {
    fn read_default_value(&self, path: &str) -> Option<String>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AdapterVendor {
    Wps,
    MicrosoftOffice,
    Adobe,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct AdapterDetectionRule {
    adapter_id: &'static str,
    prog_ids: &'static [&'static str],
    vendor: AdapterVendor,
    expected_executable: &'static str,
}

const DETECTION_RULES: &[AdapterDetectionRule] = &[
    AdapterDetectionRule {
        adapter_id: "office_word",
        prog_ids: &["Word.Application"],
        vendor: AdapterVendor::MicrosoftOffice,
        expected_executable: "winword.exe",
    },
    AdapterDetectionRule {
        adapter_id: "office_excel",
        prog_ids: &["Excel.Application"],
        vendor: AdapterVendor::MicrosoftOffice,
        expected_executable: "excel.exe",
    },
    AdapterDetectionRule {
        adapter_id: "office_powerpoint",
        prog_ids: &["PowerPoint.Application"],
        vendor: AdapterVendor::MicrosoftOffice,
        expected_executable: "powerpnt.exe",
    },
    AdapterDetectionRule {
        adapter_id: "wps_writer",
        prog_ids: &["KWPS.Application"],
        vendor: AdapterVendor::Wps,
        expected_executable: "wps.exe",
    },
    AdapterDetectionRule {
        adapter_id: "wps_spreadsheet",
        prog_ids: &["KET.Application"],
        vendor: AdapterVendor::Wps,
        expected_executable: "wps.exe",
    },
    AdapterDetectionRule {
        adapter_id: "wps_presentation",
        prog_ids: &["KWPP.Application"],
        vendor: AdapterVendor::Wps,
        expected_executable: "wps.exe",
    },
    AdapterDetectionRule {
        adapter_id: "photoshop",
        prog_ids: &["Photoshop.Application"],
        vendor: AdapterVendor::Adobe,
        expected_executable: "photoshop.exe",
    },
    AdapterDetectionRule {
        adapter_id: "illustrator",
        prog_ids: &["Illustrator.Application"],
        vendor: AdapterVendor::Adobe,
        expected_executable: "illustrator.exe",
    },
];

pub fn discover_adapter_install_status(adapter_id: &str) -> AdapterInstallStatus {
    #[cfg(windows)]
    {
        let registry = WindowsRegistryReader;
        return discover_installed_adapter(&registry, adapter_id);
    }

    #[cfg(not(windows))]
    {
        let _ = adapter_id;
        AdapterInstallStatus::default()
    }
}

pub fn discover_installed_adapter(
    registry: &dyn RegistryReader,
    adapter_id: &str,
) -> AdapterInstallStatus {
    let Some(rule) = DETECTION_RULES
        .iter()
        .find(|rule| rule.adapter_id == adapter_id)
    else {
        return AdapterInstallStatus::default();
    };

    for prog_id in rule.prog_ids {
        let Some(local_server) = resolve_local_server(registry, prog_id) else {
            continue;
        };

        if local_server_matches_rule(&local_server, rule) {
            return AdapterInstallStatus {
                installed: true,
                evidence: Some(local_server),
            };
        }
    }

    AdapterInstallStatus::default()
}

fn resolve_local_server(registry: &dyn RegistryReader, prog_id: &str) -> Option<String> {
    let clsid = registry.read_default_value(&format!("{prog_id}\\CLSID"))?;
    registry
        .read_default_value(&format!("CLSID\\{clsid}\\LocalServer32"))
        .or_else(|| {
            registry.read_default_value(&format!("WOW6432Node\\CLSID\\{clsid}\\LocalServer32"))
        })
}

fn local_server_matches_rule(local_server: &str, rule: &AdapterDetectionRule) -> bool {
    let normalized = local_server.to_ascii_lowercase();

    match rule.vendor {
        AdapterVendor::Wps => {
            let executable_matches = normalized.contains(rule.expected_executable)
                || normalized.contains("\\wpsoffice.exe");
            executable_matches
                && (normalized.contains("kingsoft")
                    || normalized.contains("wps office")
                    || normalized.contains("\\wps.exe")
                    || normalized.contains("\\wpsoffice.exe"))
        }
        AdapterVendor::MicrosoftOffice => {
            normalized.contains(rule.expected_executable)
                && !normalized.contains("kingsoft")
                && !normalized.contains("wps office")
                && !normalized.contains("\\wps.exe")
        }
        AdapterVendor::Adobe => {
            normalized.contains(rule.expected_executable) && normalized.contains("adobe")
        }
    }
}

#[cfg(windows)]
struct WindowsRegistryReader;

#[cfg(windows)]
impl RegistryReader for WindowsRegistryReader {
    fn read_default_value(&self, path: &str) -> Option<String> {
        use winreg::enums::{HKEY_CLASSES_ROOT, HKEY_CURRENT_USER};
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if let Ok(key) = hkcu.open_subkey(format!("Software\\Classes\\{path}")) {
            if let Ok(value) = key.get_value::<String, _>("") {
                return Some(value);
            }
        }

        let hkcr = RegKey::predef(HKEY_CLASSES_ROOT);
        hkcr.open_subkey(path)
            .ok()
            .and_then(|key| key.get_value::<String, _>("").ok())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Default)]
    struct MockRegistry {
        values: HashMap<String, String>,
    }

    impl MockRegistry {
        fn with_value(mut self, path: &str, value: &str) -> Self {
            self.values
                .insert(path.to_ascii_lowercase(), value.to_string());
            self
        }
    }

    impl RegistryReader for MockRegistry {
        fn read_default_value(&self, path: &str) -> Option<String> {
            self.values.get(&path.to_ascii_lowercase()).cloned()
        }
    }

    #[test]
    fn discovers_wps_from_wps_specific_progids_without_marking_hijacked_office() {
        let registry = MockRegistry::default()
            .with_value(
                r"KWPS.Application\CLSID",
                "{000209FF-0000-4b30-A977-D214852036FF}",
            )
            .with_value(
                r"Word.Application\CLSID",
                "{000209FF-0000-4b30-A977-D214852036FF}",
            )
            .with_value(
                r"CLSID\{000209FF-0000-4b30-A977-D214852036FF}\LocalServer32",
                r"C:\Users\demo\AppData\Local\Kingsoft\WPS Office\office6\wps.exe /prometheus /wps /Automation",
            );

        assert_eq!(
            discover_installed_adapter(&registry, "wps_writer").installed,
            true
        );
        assert_eq!(
            discover_installed_adapter(&registry, "office_word").installed,
            false
        );
    }

    #[test]
    fn discovers_wps_writer_from_unified_wpsoffice_local_server() {
        let registry = MockRegistry::default()
            .with_value(
                r"KWPS.Application\CLSID",
                "{000209FF-0000-4b30-A977-D214852036FF}",
            )
            .with_value(
                r"CLSID\{000209FF-0000-4b30-A977-D214852036FF}\LocalServer32",
                r#""C:\Users\demo\AppData\Local\Kingsoft\WPS Office\12.1.0.26895\office6\wpsoffice.exe" /Automation"#,
            );

        let status = discover_installed_adapter(&registry, "wps_writer");

        assert_eq!(status.installed, true);
        assert!(status
            .evidence
            .unwrap_or_default()
            .contains("wpsoffice.exe"));
    }

    #[test]
    fn discovers_32_bit_wps_from_wow6432node_clsid_registration() {
        let registry = MockRegistry::default()
            .with_value(
                r"KWPS.Application\CLSID",
                "{000209FF-0000-4b30-A977-D214852036FF}",
            )
            .with_value(
                r"WOW6432Node\CLSID\{000209FF-0000-4b30-A977-D214852036FF}\LocalServer32",
                r"C:\Users\demo\AppData\Local\Kingsoft\WPS Office\office6\wps.exe /prometheus /wps /Automation",
            );

        assert_eq!(
            discover_installed_adapter(&registry, "wps_writer").installed,
            true
        );
    }

    #[test]
    fn discovers_microsoft_office_only_when_local_server_matches_office_executable() {
        let registry = MockRegistry::default()
            .with_value(
                r"Word.Application\CLSID",
                "{00020906-0000-0000-C000-000000000046}",
            )
            .with_value(
                r"CLSID\{00020906-0000-0000-C000-000000000046}\LocalServer32",
                r"C:\Program Files\Microsoft Office\root\Office16\WINWORD.EXE /Automation",
            );

        let status = discover_installed_adapter(&registry, "office_word");

        assert_eq!(status.installed, true);
        assert!(status.evidence.unwrap_or_default().contains("WINWORD.EXE"));
    }

    #[test]
    fn discovers_adobe_apps_from_their_com_local_server() {
        let registry = MockRegistry::default()
            .with_value(
                r"Photoshop.Application\CLSID",
                "{6DECC242-87EF-11CF-86B4-444553540000}",
            )
            .with_value(
                r"CLSID\{6DECC242-87EF-11CF-86B4-444553540000}\LocalServer32",
                r"C:\Program Files\Adobe\Adobe Photoshop 2026\Photoshop.exe",
            );

        assert_eq!(
            discover_installed_adapter(&registry, "photoshop").installed,
            true
        );
        assert_eq!(
            discover_installed_adapter(&registry, "illustrator").installed,
            false
        );
    }
}
