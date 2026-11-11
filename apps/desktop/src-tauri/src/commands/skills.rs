// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! User and bundled Agent Skills commands.

mod state;

use std::{
    collections::BTreeSet,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tauri::{Runtime, State, WebviewWindow};
use tauri_plugin_opener::OpenerExt;

use crate::core::{
    database::DatabaseRuntime,
    system::paths::{app_directory_path, AppDirectory},
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSkillFile {
    pub directory_name: String,
    pub path: String,
    pub directory: String,
    pub frontmatter: String,
    pub disabled: bool,
    pub scope: SkillRootScope,
}

static SYSTEM_SKILL_INSTALL_LOCK: Mutex<()> = Mutex::new(());
const BUNDLED_WIDGET_SKILL: &str = concat!(
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../src/prompts/skills/widget/SKILL.md"
    )),
    "\n",
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../src/prompts/skills/widget/references/ui_components.md"
    )),
    "\n",
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../src/prompts/skills/widget/references/color_palette.md"
    )),
    "\n",
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../src/prompts/skills/widget/references/charts.md"
    )),
    "\n",
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../src/prompts/skills/widget/references/svg_setup.md"
    )),
    "\n",
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../src/prompts/skills/widget/references/diagram_overview.md"
    )),
    "\n",
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../src/prompts/skills/widget/references/diagram_flowchart.md"
    )),
    "\n",
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../src/prompts/skills/widget/references/diagram_structural.md"
    )),
    "\n",
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../src/prompts/skills/widget/references/diagram_illustrative.md"
    )),
    "\n",
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../src/prompts/skills/widget/references/art_and_illustration.md"
    )),
);
struct BundledSkill {
    name: &'static str,
    content: &'static str,
}

const BUNDLED_SKILLS: &[BundledSkill] = &[
    BundledSkill {
        name: "widget",
        content: BUNDLED_WIDGET_SKILL,
    },
    BundledSkill {
        name: "skill-creator",
        content: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/prompts/skills/skill-creator/SKILL.md"
        )),
    },
];
const MAX_DISCOVERED_SKILLS: usize = 1024;
const MAX_CATALOG_BYTES: usize = 8 * 1024 * 1024;

const MAX_DISCOVERY_FRONTMATTER_BYTES: usize = 64 * 1024;
const MAX_SKILL_CONTENT_BYTES: u64 = 200_000;
const RAW_SKILL_CONTENT_READ_WINDOW_LABELS: &[&str] = &["settings"];
const ENABLED_SKILL_CONTENT_READ_WINDOW_LABELS: &[&str] = &["main"];

fn user_home_dir() -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            return Ok(PathBuf::from(profile));
        }

        if let (Some(drive), Some(path)) =
            (std::env::var_os("HOMEDRIVE"), std::env::var_os("HOMEPATH"))
        {
            return Ok(PathBuf::from(format!(
                "{}{}",
                drive.to_string_lossy(),
                path.to_string_lossy()
            )));
        }
    }

    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "无法定位用户主目录".to_string())
}

fn user_skills_root() -> Result<PathBuf, String> {
    Ok(user_home_dir()?.join(".agents").join("skills"))
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SkillRootScope {
    App,
    Shared,
}

#[derive(Debug, Clone, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillId {
    scope: SkillRootScope,
    directory_name: String,
}

impl SkillId {
    fn new(scope: SkillRootScope, directory_name: String) -> Result<Self, String> {
        validate_skill_directory_name(&directory_name)?;
        Ok(Self {
            scope,
            directory_name,
        })
    }

    fn from_skill_file(scope: SkillRootScope, path: &Path) -> Result<Self, String> {
        let directory_name = path
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            .ok_or_else(|| "Skill directory name is not valid UTF-8".to_string())?;
        Self::new(scope, directory_name.to_string())
    }
}

fn validate_skill_directory_name(directory_name: &str) -> Result<(), String> {
    if directory_name.is_empty()
        || directory_name == "."
        || directory_name == ".."
        || directory_name.starts_with('.')
        || directory_name.contains('/')
        || directory_name.contains('\\')
        || directory_name.contains('\0')
    {
        return Err("Skill state contains an invalid directory name".into());
    }
    Ok(())
}

#[derive(Clone)]
struct EditableSkillRoot {
    directory: PathBuf,
    scope: SkillRootScope,
}

fn editable_skill_roots_at(app_root: &Path, shared_root: &Path) -> [EditableSkillRoot; 2] {
    let directory = app_root.join("skills");
    [
        EditableSkillRoot {
            directory,
            scope: SkillRootScope::App,
        },
        EditableSkillRoot {
            directory: shared_root.to_path_buf(),
            scope: SkillRootScope::Shared,
        },
    ]
}

fn editable_skill_roots() -> Result<[EditableSkillRoot; 2], String> {
    Ok(editable_skill_roots_at(
        &system_skills_app_root()?,
        &user_skills_root()?,
    ))
}

fn resolve_editable_skill_root<'a>(
    roots: &'a [EditableSkillRoot],
    path: &Path,
) -> Result<&'a EditableSkillRoot, String> {
    roots
        .iter()
        .find(|root| validate_direct_child_skill_file(&root.directory, path).is_ok())
        .ok_or_else(|| "Skill is outside the editable skills directories".to_string())
}

fn selected_skills_root(scope: Option<SkillRootScope>) -> Result<PathBuf, String> {
    match scope {
        Some(SkillRootScope::App) => Ok(system_skills_app_root()?.join("skills")),
        _ => user_skills_root(),
    }
}

fn normalize_existing_path(path: &Path, label: &str) -> Result<PathBuf, String> {
    path.canonicalize()
        .map_err(|error| format!("无法访问{}：{}", label, error))
}

fn ensure_allowed_window<R: Runtime>(
    window: &WebviewWindow<R>,
    allowed: &[&str],
) -> Result<(), String> {
    if is_window_label_allowed(window.label(), allowed) {
        return Ok(());
    }

    Err("当前窗口无权访问用户 Skills".to_string())
}

fn is_window_label_allowed(window_label: &str, allowed: &[&str]) -> bool {
    allowed.iter().any(|label| *label == window_label)
}

fn raw_skill_content_read_window_labels() -> &'static [&'static str] {
    RAW_SKILL_CONTENT_READ_WINDOW_LABELS
}

fn validate_direct_child_skill_file(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let root = normalize_existing_path(root, "Skills 根目录")?;
    let path = normalize_existing_path(path, "Skill.md")?;
    if !path.is_file() {
        return Err("目标不是技能文件".to_string());
    }

    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return Err("技能文件路径无效".to_string());
    };
    if !file_name.eq_ignore_ascii_case("SKILL.md") {
        return Err("只能读取直接子技能目录下的 SKILL.md".to_string());
    }

    let Some(skill_dir) = path.parent() else {
        return Err("技能文件路径无效".to_string());
    };
    if skill_dir
        .file_name()
        .is_some_and(|name| name.to_string_lossy().starts_with('.'))
    {
        return Err("Hidden skill directories are reserved for app management".into());
    }
    if skill_dir.parent() != Some(root.as_path()) {
        return Err("只能读取直接子技能目录下的 SKILL.md".to_string());
    }

    Ok(path)
}

fn validate_direct_child_skill_directory(root: &Path, directory: &Path) -> Result<PathBuf, String> {
    let root = normalize_existing_path(root, "Skills 根目录")?;
    let directory = normalize_existing_path(directory, "技能目录")?;
    if !directory.is_dir() {
        return Err("目标不是技能目录".to_string());
    }

    if directory.parent() != Some(root.as_path()) {
        return Err("只能删除用户 Skills 根目录下的直接子目录".to_string());
    }

    let skill_file = directory.join("SKILL.md");
    validate_direct_child_skill_file(&root, &skill_file)?;
    Ok(directory)
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn read_direct_child_skill_file(root: &Path, path: &Path) -> Result<String, String> {
    let path = validate_direct_child_skill_file(root, path)?;
    let metadata = fs::metadata(&path).map_err(|error| format!("读取技能文件失败：{}", error))?;
    if metadata.len() > MAX_SKILL_CONTENT_BYTES {
        return Err(format!(
            "技能文件过大，无法读取（{} / {} bytes）",
            metadata.len(),
            MAX_SKILL_CONTENT_BYTES
        ));
    }

    let mut file = File::open(&path).map_err(|error| format!("读取技能文件失败：{}", error))?;
    let mut buffer = Vec::with_capacity(metadata.len() as usize);
    Read::by_ref(&mut file)
        .take(MAX_SKILL_CONTENT_BYTES + 1)
        .read_to_end(&mut buffer)
        .map_err(|error| format!("读取技能文件失败：{}", error))?;
    if buffer.len() as u64 > MAX_SKILL_CONTENT_BYTES {
        return Err(format!(
            "技能文件过大，无法读取（超过 {} bytes）",
            MAX_SKILL_CONTENT_BYTES
        ));
    }

    String::from_utf8(buffer).map_err(|error| format!("技能文件不是有效 UTF-8：{}", error))
}

fn read_enabled_direct_child_skill_file(
    root: &EditableSkillRoot,
    path: &Path,
    disabled_skills: &BTreeSet<SkillId>,
) -> Result<String, String> {
    let path = validate_direct_child_skill_file(&root.directory, path)?;
    let skill_id = SkillId::from_skill_file(root.scope, &path)?;
    if disabled_skills.contains(&skill_id) {
        return Err("技能已禁用，无法读取".to_string());
    }

    read_direct_child_skill_file(&root.directory, &path)
}

fn system_skills_app_root() -> Result<PathBuf, String> {
    app_directory_path(AppDirectory::Data)?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "Cannot resolve the system skills app root".to_string())
}

fn system_path_metadata(path: &Path) -> Result<Option<fs::Metadata>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Cannot inspect system skill path: {error}")),
    };
    let is_link = metadata.file_type().is_symlink();
    #[cfg(windows)]
    let is_link = {
        use std::os::windows::fs::MetadataExt;
        use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        is_link || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0
    };
    if is_link {
        return Err("System skill paths cannot contain links or reparse points".into());
    }
    Ok(Some(metadata))
}

fn validate_system_directory(path: &Path) -> Result<PathBuf, String> {
    let metadata = system_path_metadata(path)?
        .ok_or_else(|| "System skill directory does not exist".to_string())?;
    if !metadata.is_dir() {
        return Err("System skill path is not a directory".into());
    }
    normalize_existing_path(path, "system skill directory")
}

fn system_skill_directory(app_root: &Path, name: &str, create: bool) -> Result<PathBuf, String> {
    let mut directory = validate_system_directory(app_root)?;
    for component in ["skills", ".system", name] {
        let child = directory.join(component);
        if create {
            match fs::create_dir(&child) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => {
                    return Err(format!("Cannot create system skill directory: {error}"));
                }
            }
        }
        let resolved = validate_system_directory(&child)?;
        if resolved != child {
            return Err("System skill directory escaped the app root".into());
        }
        directory = resolved;
    }
    Ok(directory)
}

fn system_skill_file_metadata(path: &Path) -> Result<Option<fs::Metadata>, String> {
    let metadata = system_path_metadata(path)?;
    if metadata
        .as_ref()
        .is_some_and(|metadata| !metadata.is_file())
    {
        return Err("System skill path is not a regular file".into());
    }
    Ok(metadata)
}

fn install_system_skill(app_root: &Path, skill: &BundledSkill) -> Result<PathBuf, String> {
    let directory = system_skill_directory(app_root, skill.name, true)?;
    let path = directory.join("SKILL.md");
    if let Some(metadata) = system_skill_file_metadata(&path)? {
        if metadata.len() == skill.content.len() as u64 {
            let file = File::open(&path)
                .map_err(|error| format!("Cannot inspect installed system skill: {error}"))?;
            let mut existing = Vec::with_capacity(skill.content.len());
            file.take(skill.content.len() as u64 + 1)
                .read_to_end(&mut existing)
                .map_err(|error| format!("Cannot inspect installed system skill: {error}"))?;
            if existing == skill.content.as_bytes() {
                return Ok(path);
            }
        }
    }

    let mut temporary = tempfile::NamedTempFile::new_in(&directory)
        .map_err(|error| format!("Cannot install system skill: {error}"))?;
    temporary
        .write_all(skill.content.as_bytes())
        .and_then(|()| temporary.as_file().sync_all())
        .map_err(|error| format!("Cannot install system skill: {error}"))?;
    // Recheck the managed destination before replacing only the bundled file.
    if system_skill_directory(app_root, skill.name, false)? != directory {
        return Err("System skill directory changed during installation".into());
    }
    system_skill_file_metadata(&path)?;
    temporary
        .persist(&path)
        .map_err(|error| format!("Cannot install system skill: {error}"))?;
    Ok(path)
}

fn discover_system_skill_files(app_root: &Path) -> Result<Vec<UserSkillFile>, String> {
    let _guard = SYSTEM_SKILL_INSTALL_LOCK
        .lock()
        .map_err(|_| "System skill installation lock unavailable".to_string())?;
    BUNDLED_SKILLS
        .iter()
        .map(|skill| {
            let frontmatter = read_skill_frontmatter(skill.content.as_bytes())?;
            let path = install_system_skill(app_root, skill)?;
            let directory = path
                .parent()
                .ok_or_else(|| "Invalid system skill path".to_string())?;
            Ok(UserSkillFile {
                directory_name: skill.name.into(),
                path: path_to_string(&path),
                directory: path_to_string(directory),
                frontmatter,
                disabled: false,
                scope: SkillRootScope::App,
            })
        })
        .collect()
}

fn registered_system_skill_content(
    app_root: &Path,
    path: &Path,
) -> Result<Option<&'static str>, String> {
    for skill in BUNDLED_SKILLS {
        let relative = Path::new("skills/.system")
            .join(skill.name)
            .join("SKILL.md");
        let is_registered = path == app_root.join(&relative)
            || app_root
                .canonicalize()
                .is_ok_and(|root| path == root.join(&relative));
        if is_registered {
            let directory = system_skill_directory(app_root, skill.name, false)?;
            system_skill_file_metadata(&directory.join("SKILL.md"))?
                .ok_or_else(|| "System skill file does not exist".to_string())?;
            // Installed copies are inspectable; activation trusts only registered embedded bytes.
            return Ok(Some(skill.content));
        }
    }
    Ok(None)
}

fn read_skill_file(
    app_root: &Path,
    user_root: &Path,
    path: &Path,
    disabled_skills: Option<&BTreeSet<SkillId>>,
) -> Result<String, String> {
    if let Some(content) = registered_system_skill_content(app_root, path)? {
        return Ok(content.to_string());
    }
    let roots = editable_skill_roots_at(app_root, user_root);
    let root = resolve_editable_skill_root(&roots, path)?;
    match disabled_skills {
        Some(skills) => read_enabled_direct_child_skill_file(root, path, skills),
        None => read_direct_child_skill_file(&root.directory, path),
    }
}

fn is_frontmatter_delimiter_bytes(line: &[u8], allow_bom: bool) -> bool {
    let mut content = line;
    if content.ends_with(b"\n") {
        content = &content[..content.len() - 1];
    }
    if content.ends_with(b"\r") {
        content = &content[..content.len() - 1];
    }
    if allow_bom && content.starts_with(b"\xEF\xBB\xBF") {
        content = &content[3..];
    }

    content == b"---"
}

fn parse_frontmatter_line(line: &[u8], is_first_line: bool) -> Result<bool, String> {
    if is_first_line {
        if is_frontmatter_delimiter_bytes(line, true) {
            return Ok(false);
        }

        return Err("SKILL.md 必须以 YAML frontmatter 开头".to_string());
    }

    Ok(is_frontmatter_delimiter_bytes(line, false))
}

fn frontmatter_from_bytes(bytes: Vec<u8>) -> Result<String, String> {
    String::from_utf8(bytes).map_err(|error| format!("技能元数据不是有效 UTF-8：{}", error))
}

fn read_direct_child_skill_frontmatter(root: &Path, path: &Path) -> Result<String, String> {
    let path = validate_direct_child_skill_file(root, path)?;
    let file = File::open(&path).map_err(|error| format!("读取技能元数据失败：{}", error))?;
    read_skill_frontmatter(file)
}

fn read_skill_frontmatter(mut file: impl Read) -> Result<String, String> {
    let mut frontmatter = Vec::new();
    let mut line = Vec::new();
    let mut is_first_line = true;
    let mut buffer = [0_u8; 1024];

    loop {
        let bytes_read = file
            .read(&mut buffer)
            .map_err(|error| format!("读取技能元数据失败：{}", error))?;
        if bytes_read == 0 {
            if frontmatter.is_empty() {
                return Err("技能文件为空".to_string());
            }
            if !line.is_empty() && parse_frontmatter_line(&line, is_first_line)? {
                return frontmatter_from_bytes(frontmatter);
            }

            return Err("SKILL.md frontmatter 未闭合".to_string());
        }

        for byte in &buffer[..bytes_read] {
            frontmatter.push(*byte);
            line.push(*byte);
            if frontmatter.len() > MAX_DISCOVERY_FRONTMATTER_BYTES {
                return Err("技能元数据过大".to_string());
            }

            if *byte == b'\n' {
                if parse_frontmatter_line(&line, is_first_line)? {
                    return frontmatter_from_bytes(frontmatter);
                }
                is_first_line = false;
                line.clear();
            }
        }
    }
}

async fn set_disabled_skill_path(
    pool: &SqlitePool,
    roots: &[EditableSkillRoot],
    path: &Path,
    disabled: bool,
) -> Result<(), String> {
    state::load(pool).await?;
    let mut transaction = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|error| format!("Cannot begin skill state update: {error}"))?;
    let locations = roots.to_vec();
    let path = path.to_path_buf();
    let skill_id = tauri::async_runtime::spawn_blocking(move || {
        let root = resolve_editable_skill_root(&locations, &path)?;
        let path = validate_direct_child_skill_file(&root.directory, &path)?;
        SkillId::from_skill_file(root.scope, &path)
    })
    .await
    .map_err(|error| format!("Skill operation failed: {error}"))??;
    state::set_disabled(&mut transaction, skill_id, disabled).await?;
    transaction
        .commit()
        .await
        .map_err(|error| format!("Cannot commit skill state update: {error}"))
}

async fn delete_direct_child_skill_directory(
    pool: &SqlitePool,
    roots: &[EditableSkillRoot],
    directory: &Path,
    remove_directory: impl FnOnce(&Path) -> std::io::Result<()> + Send + 'static,
) -> Result<(), String> {
    let locations = roots.to_vec();
    let directory = directory.to_path_buf();
    let (root, directory, skill_id) = tauri::async_runtime::spawn_blocking(move || {
        let root = resolve_editable_skill_root(&locations, &directory.join("SKILL.md"))?;
        let directory = validate_direct_child_skill_directory(&root.directory, &directory)?;
        let path = validate_direct_child_skill_file(&root.directory, &directory.join("SKILL.md"))?;
        let skill_id = SkillId::from_skill_file(root.scope, &path)?;
        Ok::<_, String>((root.clone(), directory, skill_id))
    })
    .await
    .map_err(|error| format!("Skill operation failed: {error}"))??;
    state::load(pool).await?;
    let mut transaction = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|error| format!("Cannot begin skill deletion: {error}"))?;
    let mut skills = state::read(&mut *transaction)
        .await?
        .ok_or_else(|| "Skill state is missing".to_string())?;
    skills.remove(&skill_id);
    // Validate the database write before removing content; a filesystem error rolls it back.
    state::write(&mut transaction, &skills).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let directory = validate_direct_child_skill_directory(&root.directory, &directory)?;
        remove_directory(&directory).map_err(|error| format!("删除技能目录失败：{error}"))
    })
    .await
    .map_err(|error| format!("Skill operation failed: {error}"))??;
    transaction
        .commit()
        .await
        .map_err(|error| format!("Cannot commit skill deletion: {error}"))
}

#[tauri::command]
pub fn agent_skills_get_user_root<R: Runtime>(
    window: WebviewWindow<R>,
    scope: Option<SkillRootScope>,
) -> Result<String, String> {
    ensure_allowed_window(&window, &["main", "settings"])?;
    selected_skills_root(scope).map(|path| path_to_string(&path))
}

#[tauri::command]
pub async fn agent_skills_discover_system_files<R: Runtime>(
    window: WebviewWindow<R>,
) -> Result<Vec<UserSkillFile>, String> {
    ensure_allowed_window(&window, &["main", "settings"])?;
    tauri::async_runtime::spawn_blocking(move || {
        discover_system_skill_files(&system_skills_app_root()?)
    })
    .await
    .map_err(|error| format!("Skill operation failed: {error}"))?
}

#[tauri::command]
pub async fn agent_skills_discover_user_files<R: Runtime>(
    window: WebviewWindow<R>,
    database: State<'_, DatabaseRuntime>,
) -> Result<Vec<UserSkillFile>, String> {
    ensure_allowed_window(&window, &["main", "settings"])?;
    let roots = editable_skill_roots()?;
    let disabled = state::load(database.pool()).await?;
    tauri::async_runtime::spawn_blocking(move || discover_editable_skill_files(&roots, &disabled))
        .await
        .map_err(|error| format!("Skill operation failed: {}", error))?
}

fn discover_editable_skill_files(
    roots: &[EditableSkillRoot],
    disabled_skills: &BTreeSet<SkillId>,
) -> Result<Vec<UserSkillFile>, String> {
    let mut files = Vec::new();
    let mut metadata_bytes = 0;
    let mut entries_seen = 0;
    for location in roots {
        let root = &location.directory;
        let entries = match fs::read_dir(root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("Cannot discover user skills: {}", error)),
        };

        for entry in entries {
            entries_seen += 1;
            if entries_seen > MAX_DISCOVERED_SKILLS {
                return Err("Too many skill directories".into());
            }
            let entry = entry.map_err(|error| format!("Cannot discover user skills: {}", error))?;
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }

            let directory = entry.path();
            let skill_path = directory.join("SKILL.md");
            let Ok(frontmatter) = read_direct_child_skill_frontmatter(root, &skill_path) else {
                continue;
            };
            let Ok(skill_path) = validate_direct_child_skill_file(root, &skill_path) else {
                continue;
            };
            metadata_bytes += frontmatter.len();
            if metadata_bytes > MAX_CATALOG_BYTES {
                return Err("Skill catalog is too large".into());
            }
            let Some(directory) = skill_path.parent() else {
                continue;
            };
            let directory_name = entry.file_name().to_string_lossy().to_string();
            let skill_path_string = path_to_string(&skill_path);
            let skill_id = SkillId::new(location.scope, directory_name.clone())?;
            files.push(UserSkillFile {
                directory_name,
                path: skill_path_string.clone(),
                directory: path_to_string(directory),
                frontmatter,
                disabled: disabled_skills.contains(&skill_id),
                scope: location.scope,
            });
        }
    }
    files.sort_by(|left, right| {
        left.directory_name
            .cmp(&right.directory_name)
            .then(left.path.cmp(&right.path))
    });
    files.dedup_by(|left, right| left.path == right.path);
    Ok(files)
}

#[tauri::command]
pub async fn agent_skills_read_user_file<R: Runtime>(
    window: WebviewWindow<R>,
    path: String,
) -> Result<String, String> {
    ensure_allowed_window(&window, raw_skill_content_read_window_labels())?;
    tauri::async_runtime::spawn_blocking(move || {
        read_skill_file(
            &system_skills_app_root()?,
            &user_skills_root()?,
            Path::new(&path),
            None,
        )
    })
    .await
    .map_err(|error| format!("Skill operation failed: {}", error))?
}

#[tauri::command]
pub async fn agent_skills_read_enabled_user_file<R: Runtime>(
    window: WebviewWindow<R>,
    database: State<'_, DatabaseRuntime>,
    path: String,
) -> Result<String, String> {
    ensure_allowed_window(&window, ENABLED_SKILL_CONTENT_READ_WINDOW_LABELS)?;
    let disabled = state::load(database.pool()).await?;
    tauri::async_runtime::spawn_blocking(move || {
        read_skill_file(
            &system_skills_app_root()?,
            &user_skills_root()?,
            Path::new(&path),
            Some(&disabled),
        )
    })
    .await
    .map_err(|error| format!("Skill operation failed: {}", error))?
}

#[tauri::command]
pub async fn agent_skills_delete_user_directory<R: Runtime>(
    window: WebviewWindow<R>,
    database: State<'_, DatabaseRuntime>,
    directory: String,
) -> Result<(), String> {
    ensure_allowed_window(&window, &["settings"])?;
    delete_direct_child_skill_directory(
        database.pool(),
        &editable_skill_roots()?,
        Path::new(&directory),
        |path| fs::remove_dir_all(path),
    )
    .await
}

#[tauri::command]
pub async fn agent_skills_set_user_skill_disabled<R: Runtime>(
    window: WebviewWindow<R>,
    database: State<'_, DatabaseRuntime>,
    path: String,
    disabled: bool,
) -> Result<(), String> {
    ensure_allowed_window(&window, &["settings"])?;
    set_disabled_skill_path(
        database.pool(),
        &editable_skill_roots()?,
        Path::new(&path),
        disabled,
    )
    .await
}

#[tauri::command]
pub fn agent_skills_open_user_root<R: Runtime>(
    window: WebviewWindow<R>,
    scope: Option<SkillRootScope>,
) -> Result<(), String> {
    ensure_allowed_window(&window, &["settings"])?;
    let root = selected_skills_root(scope)?;
    if !root.exists() {
        fs::create_dir_all(&root).map_err(|error| format!("打开 Skills 根目录失败：{}", error))?;
    }

    window
        .opener()
        .open_path(path_to_string(&root), None::<String>)
        .map_err(|error| format!("打开 Skills 根目录失败：{}", error))
}

#[tauri::command]
pub fn agent_skills_open_user_directory<R: Runtime>(
    window: WebviewWindow<R>,
    directory: String,
) -> Result<(), String> {
    ensure_allowed_window(&window, &["settings"])?;
    let roots = editable_skill_roots()?;
    let root = resolve_editable_skill_root(&roots, &Path::new(&directory).join("SKILL.md"))?;
    let directory = validate_direct_child_skill_directory(&root.directory, Path::new(&directory))?;

    window
        .opener()
        .open_path(path_to_string(&directory), None::<String>)
        .map_err(|error| format!("打开技能目录失败：{}", error))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn widget_path(app_root: &Path) -> PathBuf {
        app_root.join("skills/.system/widget/SKILL.md")
    }

    #[test]
    fn user_given_the_bundled_catalog_when_writing_a_skill_then_can_load_the_authoring_guide() {
        let temp = tempfile::tempdir().unwrap();
        let files = discover_system_skill_files(temp.path()).unwrap();
        let creator = files
            .iter()
            .find(|skill| skill.directory_name == "skill-creator")
            .expect("authoring skill is discoverable");
        let content = read_skill_file(
            temp.path(),
            &temp.path().join("shared"),
            Path::new(&creator.path),
            None,
        )
        .unwrap();
        assert!(content.starts_with(&creator.frontmatter));
        assert_eq!(fs::read_to_string(&creator.path).unwrap(), content);
        assert!(
            creator.path.ends_with("skill-creator\\SKILL.md")
                || creator.path.ends_with("skill-creator/SKILL.md")
        );
    }

    #[tokio::test]
    async fn user_given_private_and_shared_skills_when_discovering_then_preserves_both_identities_and_states(
    ) {
        let temp = tempfile::tempdir().unwrap();
        let database = DatabaseRuntime::initialize_for_tests(temp.path())
            .await
            .unwrap();
        let app = temp.path().join("app");
        let private = write_skill(&app.join("skills"), "same").join("SKILL.md");
        let shared = temp.path().join("shared");
        let common = write_skill(&shared, "same").join("SKILL.md");
        write_skill(&app.join("skills"), ".system");
        let roots = editable_skill_roots_at(&app, &shared);
        set_disabled_skill_path(database.pool(), &roots, &private, true)
            .await
            .unwrap();
        let files =
            discover_editable_skill_files(&roots, &state::load(database.pool()).await.unwrap())
                .unwrap();
        assert_eq!(files.len(), 2);
        for (path, scope, disabled) in [(&private, "app", true), (&common, "shared", false)] {
            let file = files
                .iter()
                .find(|file| file.path == path_to_string(&path.canonicalize().unwrap()))
                .unwrap();
            assert_eq!(serde_json::to_value(file).unwrap()["scope"], scope);
            assert_eq!(file.disabled, disabled);
        }
        delete_direct_child_skill_directory(
            database.pool(),
            &roots,
            private.parent().unwrap(),
            |path| fs::remove_dir_all(path),
        )
        .await
        .unwrap();
        assert!(common.exists());
        assert_eq!(
            discover_editable_skill_files(&roots, &state::load(database.pool()).await.unwrap())
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn user_given_an_app_skill_when_reading_then_needs_no_shared_directory() {
        let temp = tempfile::tempdir().unwrap();
        let app_root = temp.path().join("app");
        let path = write_skill(&app_root.join("skills"), "private").join("SKILL.md");
        let shared = temp.path().join("shared");
        let disabled = BTreeSet::new();
        for state in [None, Some(&disabled)] {
            assert_eq!(
                read_skill_file(&app_root, &shared, &path, state).unwrap(),
                fs::read_to_string(&path).unwrap()
            );
        }
        assert!(!shared.exists());
    }

    #[tokio::test]
    async fn user_given_same_named_skills_when_disabling_the_app_copy_then_leaves_the_shared_copy_enabled(
    ) {
        let temp = tempfile::tempdir().unwrap();
        let database = DatabaseRuntime::initialize_for_tests(temp.path())
            .await
            .unwrap();
        let app_root = temp.path().join("app");
        let path = write_skill(&app_root.join("skills"), "same").join("SKILL.md");
        let shared = temp.path().join("shared");
        let shared_path = write_skill(&shared, "same").join("SKILL.md");
        let roots = editable_skill_roots_at(&app_root, &shared);
        set_disabled_skill_path(database.pool(), &roots, &path, true)
            .await
            .unwrap();
        let disabled = state::load(database.pool()).await.unwrap();
        assert_eq!(disabled.len(), 1);
        let error = read_skill_file(&app_root, &shared, &path, Some(&disabled)).unwrap_err();
        assert!(error.contains("技能已禁用"));
        assert!(read_skill_file(&app_root, &shared, &path, None).is_ok());
        assert_eq!(
            read_skill_file(&app_root, &shared, &shared_path, Some(&disabled)).unwrap(),
            fs::read_to_string(shared_path).unwrap()
        );
    }

    #[tokio::test]
    async fn user_given_a_disabled_skill_when_the_app_and_shared_roots_move_then_keeps_the_choice()
    {
        let temp = tempfile::tempdir().unwrap();
        let database = DatabaseRuntime::initialize_for_tests(temp.path())
            .await
            .unwrap();
        let old_app_root = temp.path().join("old-app");
        let old_shared_root = temp.path().join("old-shared");
        let old_path = write_skill(&old_app_root.join("skills"), "demo").join("SKILL.md");
        let old_root = editable_skill_roots_at(&old_app_root, &old_shared_root);
        set_disabled_skill_path(database.pool(), &old_root, &old_path, true)
            .await
            .unwrap();
        let disabled = state::load(database.pool()).await.unwrap();

        let new_app_root = temp.path().join("new-app");
        let new_shared_root = temp.path().join("new-shared");
        let new_path = write_skill(&new_app_root.join("skills"), "demo").join("SKILL.md");
        let error = read_skill_file(&new_app_root, &new_shared_root, &new_path, Some(&disabled))
            .unwrap_err();

        assert!(error.contains("技能已禁用"));
    }

    #[test]
    fn user_given_a_reserved_system_directory_when_managing_then_cannot_treat_it_as_editable() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("skills");
        let directory = write_skill(&root, ".system");
        assert!(validate_direct_child_skill_file(&root, &directory.join("SKILL.md")).is_err());
        assert!(validate_direct_child_skill_directory(&root, &directory).is_err());
    }

    #[test]
    fn user_gets_only_bundled_metadata_when_discovering_system_skills() {
        let temp = tempfile::tempdir().unwrap();
        let extra = write_skill(&temp.path().join("skills/.system"), "unregistered");

        let files = discover_system_skill_files(temp.path()).unwrap();

        assert_eq!(files.len(), 2);
        let skill = files
            .iter()
            .find(|skill| skill.directory_name == "widget")
            .unwrap();
        assert_eq!(skill.directory_name, "widget");
        assert!(!skill.disabled);
        let installed = widget_path(temp.path()).canonicalize().unwrap();
        assert_eq!(skill.path, path_to_string(&installed));
        assert_eq!(skill.directory, path_to_string(installed.parent().unwrap()));
        let content = fs::read_to_string(&installed).unwrap();
        assert_eq!(content, BUNDLED_WIDGET_SKILL);
        assert!(content.starts_with(&skill.frontmatter));
        assert!(skill.frontmatter.contains("name: widget"));
        assert!(content.len() > skill.frontmatter.len());
        assert!(skill.frontmatter.trim_end().ends_with("---"));
        let serialized = serde_json::to_value(skill).unwrap();
        assert_eq!(serialized["scope"], "app");
        assert_eq!(serialized.as_object().unwrap().len(), 6);
        assert!(extra.join("SKILL.md").exists());
        assert_eq!(
            read_skill_file(
                temp.path(),
                &temp.path().join("user-skills"),
                Path::new(&skill.path),
                None
            )
            .unwrap(),
            content
        );
    }

    #[test]
    fn user_keeps_existing_files_when_the_bundled_skill_is_updated() {
        let temp = tempfile::tempdir().unwrap();
        let directory = write_skill(&temp.path().join("skills/.system"), "widget");
        let old_skill = directory.join("SKILL.md");
        let extra = directory.join("notes.txt");
        fs::write(&extra, "keep my notes").unwrap();
        let user_skill = write_skill(&temp.path().join("user-skills"), "widget").join("SKILL.md");
        let user_content = fs::read(&user_skill).unwrap();

        discover_system_skill_files(temp.path()).unwrap();

        assert!(fs::read_to_string(old_skill)
            .unwrap()
            .contains("name: widget"));
        assert_eq!(fs::read_to_string(extra).unwrap(), "keep my notes");
        assert_eq!(fs::read(user_skill).unwrap(), user_content);
        assert_eq!(fs::read_dir(directory).unwrap().count(), 2);
    }

    #[test]
    fn user_avoids_rewriting_current_bundled_content_when_discovering_again() {
        let temp = tempfile::tempdir().unwrap();
        discover_system_skill_files(temp.path()).unwrap();
        let path = widget_path(temp.path());
        let modified = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_600_000_000);
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();
        let original = fs::metadata(&path).unwrap().modified().unwrap();

        discover_system_skill_files(temp.path()).unwrap();

        assert_eq!(fs::metadata(path).unwrap().modified().unwrap(), original);
    }

    #[test]
    fn user_reads_trusted_bundled_content_when_the_installed_copy_is_edited() {
        let temp = tempfile::tempdir().unwrap();
        let path = write_skill(&temp.path().join("skills/.system"), "widget").join("SKILL.md");
        fs::write(&path, "untrusted local replacement").unwrap();
        let user_root = temp.path().join("user-skills");
        let state = BTreeSet::new();

        for state_file in [None, Some(&state)] {
            let content = read_skill_file(temp.path(), &user_root, &path, state_file).unwrap();
            assert_eq!(content, BUNDLED_WIDGET_SKILL);
            assert!(content.contains("name: widget"));
            assert!(!content.contains("untrusted local replacement"));
        }
        assert_eq!(
            fs::read_to_string(path).unwrap(),
            "untrusted local replacement"
        );
        assert!(!user_root.exists());
    }

    #[test]
    fn user_cannot_read_unregistered_or_traversing_paths_as_system_skills() {
        let temp = tempfile::tempdir().unwrap();
        let system = temp.path().join("skills/.system");
        let widget = write_skill(&system, "widget");
        let extra = write_skill(&system, "unregistered");
        let nested = write_skill(&widget, "nested");
        fs::write(widget.join("private.txt"), "private").unwrap();
        let user_root = temp.path().join("user-skills");
        fs::create_dir(&user_root).unwrap();
        for path in [
            extra.join("SKILL.md"),
            nested.join("SKILL.md"),
            widget.join("private.txt"),
            extra.join("../widget/SKILL.md"),
            temp.path().join("skills/.system-extra/widget/SKILL.md"),
        ] {
            assert!(read_skill_file(temp.path(), &user_root, &path, None).is_err());
        }
    }

    #[tokio::test]
    async fn user_keeps_disabled_user_skills_blocked_when_system_reads_are_supported() {
        let temp = tempfile::tempdir().unwrap();
        let database = DatabaseRuntime::initialize_for_tests(temp.path())
            .await
            .unwrap();
        let root = temp.path().join("user-skills");
        let path = write_skill(&root, "widget").join("SKILL.md");
        let roots = editable_skill_roots_at(temp.path(), &root);
        set_disabled_skill_path(database.pool(), &roots, &path, true)
            .await
            .unwrap();
        let disabled = state::load(database.pool()).await.unwrap();
        let error = read_skill_file(temp.path(), &root, &path, Some(&disabled)).unwrap_err();
        assert!(error.contains("技能已禁用"));
        assert_eq!(
            read_skill_file(temp.path(), &root, &path, None).unwrap(),
            fs::read_to_string(&path).unwrap()
        );
        set_disabled_skill_path(database.pool(), &roots, &path, false)
            .await
            .unwrap();
        let disabled = state::load(database.pool()).await.unwrap();
        assert_eq!(
            read_skill_file(temp.path(), &root, &path, Some(&disabled)).unwrap(),
            fs::read_to_string(path).unwrap()
        );
    }

    #[tokio::test]
    async fn user_cannot_delete_or_disable_system_skills_through_user_actions() {
        let temp = tempfile::tempdir().unwrap();
        let database = DatabaseRuntime::initialize_for_tests(temp.path())
            .await
            .unwrap();
        let root = temp.path().join("user-skills");
        let user_skill = write_skill(&root, "widget").join("SKILL.md");
        let roots = editable_skill_roots_at(temp.path(), &root);
        set_disabled_skill_path(database.pool(), &roots, &user_skill, true)
            .await
            .unwrap();
        let original_state = state::load(database.pool()).await.unwrap();
        let system_dir = write_skill(&temp.path().join("skills/.system"), "widget");
        let system_path = system_dir.join("SKILL.md");
        let original_skill = fs::read(&system_path).unwrap();
        for disabled in [false, true] {
            assert!(
                set_disabled_skill_path(database.pool(), &roots, &system_path, disabled)
                    .await
                    .is_err()
            );
        }
        assert!(delete_direct_child_skill_directory(
            database.pool(),
            &roots,
            &system_dir,
            |_| panic!("system directory must never reach deletion")
        )
        .await
        .is_err());
        assert_eq!(fs::read(system_path).unwrap(), original_skill);
        assert_eq!(state::load(database.pool()).await.unwrap(), original_state);
        assert!(user_skill.exists());
    }

    #[test]
    fn user_preserves_unexpected_directories_when_installation_is_blocked() {
        let temp = tempfile::tempdir().unwrap();
        let path = widget_path(temp.path());
        fs::create_dir_all(&path).unwrap();
        let note = path.join("keep.txt");
        fs::write(&note, "keep").unwrap();

        assert!(discover_system_skill_files(temp.path()).is_err());

        assert_eq!(fs::read_to_string(&note).unwrap(), "keep");
    }

    #[test]
    fn user_keeps_linked_user_content_intact_when_the_bundled_copy_is_replaced() {
        let temp = tempfile::tempdir().unwrap();
        let user_file = write_skill(&temp.path().join("user-skills"), "widget").join("SKILL.md");
        let original = fs::read(&user_file).unwrap();
        let installed = widget_path(temp.path());
        fs::create_dir_all(installed.parent().unwrap()).unwrap();
        fs::hard_link(&user_file, &installed).unwrap();

        discover_system_skill_files(temp.path()).unwrap();

        assert_eq!(fs::read_to_string(installed).unwrap(), BUNDLED_WIDGET_SKILL);
        assert_eq!(fs::read(user_file).unwrap(), original);
    }

    #[test]
    fn user_gets_an_error_without_losing_existing_files_when_a_managed_directory_is_a_file() {
        for component in ["skills", "skills/.system", "skills/.system/widget"] {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join(component);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, "keep").unwrap();

            let error = discover_system_skill_files(temp.path()).unwrap_err();

            assert_eq!(error, "System skill path is not a directory");
            assert_eq!(fs::read_to_string(path).unwrap(), "keep");
        }
    }

    #[cfg(any(unix, windows))]
    fn link_directory(target: &Path, link: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
        #[cfg(windows)]
        {
            let status = std::process::Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command", "New-Item -ItemType Junction -Path $env:TOUCHAI_TEST_LINK -Target $env:TOUCHAI_TEST_TARGET -ErrorAction Stop | Out-Null"])
                .env("TOUCHAI_TEST_LINK", link)
                .env("TOUCHAI_TEST_TARGET", target)
                .status()
                .unwrap();
            assert!(status.success());
        }
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn user_cannot_install_through_a_link_that_redirects_a_managed_directory() {
        for component in [
            "",
            "skills",
            "skills/.system",
            "skills/.system/widget",
            "skills/.system/widget/SKILL.md",
        ] {
            let temp = tempfile::tempdir().unwrap();
            let app_root = temp.path().join("app");
            let outside = temp.path().join("outside");
            fs::create_dir(&outside).unwrap();
            fs::write(outside.join("keep.txt"), "keep").unwrap();
            let link = if component.is_empty() {
                app_root.clone()
            } else {
                app_root.join(component)
            };
            fs::create_dir_all(link.parent().unwrap()).unwrap();
            link_directory(&outside, &link);

            let result = discover_system_skill_files(&app_root);

            // Remove only the test-owned link before the fixture's recursive cleanup.
            #[cfg(windows)]
            fs::remove_dir(&link).unwrap();
            #[cfg(unix)]
            fs::remove_file(&link).unwrap();
            assert_eq!(
                result.unwrap_err(),
                "System skill paths cannot contain links or reparse points",
                "redirected {component} must be rejected"
            );
            assert_eq!(fs::read_dir(&outside).unwrap().count(), 1);
            assert_eq!(
                fs::read_to_string(outside.join("keep.txt")).unwrap(),
                "keep"
            );
        }
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn user_cannot_read_a_system_skill_through_a_redirected_directory() {
        let temp = tempfile::tempdir().unwrap();
        let app_root = temp.path().join("app");
        let system = app_root.join("skills/.system");
        fs::create_dir_all(&system).unwrap();
        let outside = write_skill(temp.path(), "outside");
        let link = system.join("widget");
        link_directory(&outside, &link);

        let result = read_skill_file(
            &app_root,
            &temp.path().join("user-skills"),
            &link.join("SKILL.md"),
            None,
        );

        #[cfg(windows)]
        fs::remove_dir(link).unwrap();
        #[cfg(unix)]
        fs::remove_file(link).unwrap();
        assert!(result.is_err());
        assert!(outside.join("SKILL.md").exists());
    }

    fn write_skill(root: &Path, name: &str) -> PathBuf {
        let directory = root.join(name);
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("SKILL.md"),
            "---\nname: demo\ndescription: Demo\n---",
        )
        .unwrap();
        directory
    }

    #[test]
    fn user_validates_only_direct_child_skill_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("skills");
        let skill_dir = write_skill(&root, "demo");
        let skill_file = skill_dir.join("SKILL.md");

        assert_eq!(
            validate_direct_child_skill_file(&root, &skill_file).unwrap(),
            skill_file.canonicalize().unwrap()
        );

        let nested = skill_dir.join("nested");
        fs::create_dir_all(&nested).unwrap();
        let nested_skill = nested.join("SKILL.md");
        fs::write(&nested_skill, "nested").unwrap();
        assert!(validate_direct_child_skill_file(&root, &nested_skill).is_err());

        let private_file = skill_dir.join("private.txt");
        fs::write(&private_file, "secret").unwrap();
        assert!(validate_direct_child_skill_file(&root, &private_file).is_err());
    }

    #[test]
    fn user_validates_delete_target_is_direct_skill_directory() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("skills");
        let skill_dir = write_skill(&root, "demo");

        assert_eq!(
            validate_direct_child_skill_directory(&root, &skill_dir).unwrap(),
            skill_dir.canonicalize().unwrap()
        );

        let nested = skill_dir.join("nested");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("SKILL.md"), "nested").unwrap();
        assert!(validate_direct_child_skill_directory(&root, &nested).is_err());

        let non_skill = root.join("notes");
        fs::create_dir_all(&non_skill).unwrap();
        assert!(validate_direct_child_skill_directory(&root, &non_skill).is_err());
    }

    #[test]
    fn user_reads_only_skill_frontmatter_for_discovery() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("skills");
        let skill_dir = root.join("demo");
        fs::create_dir_all(&skill_dir).unwrap();
        let skill_file = skill_dir.join("SKILL.md");
        fs::write(
            &skill_file,
            "---\nname: demo\ndescription: Demo\n---\n\nSecret body that should not leave discovery",
        )
        .unwrap();

        let frontmatter = read_direct_child_skill_frontmatter(&root, &skill_file).unwrap();

        assert_eq!(frontmatter, "---\nname: demo\ndescription: Demo\n---\n");
        assert!(!frontmatter.contains("Secret body"));
    }

    #[test]
    fn user_rejects_unclosed_frontmatter_for_discovery() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("skills");
        let skill_dir = root.join("bad");
        fs::create_dir_all(&skill_dir).unwrap();
        let skill_file = skill_dir.join("SKILL.md");
        fs::write(&skill_file, "---\nname: bad\n").unwrap();

        assert!(read_direct_child_skill_frontmatter(&root, &skill_file).is_err());
    }

    #[test]
    fn user_rejects_oversized_frontmatter_line_for_discovery() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("skills");
        let skill_dir = root.join("huge");
        fs::create_dir_all(&skill_dir).unwrap();
        let skill_file = skill_dir.join("SKILL.md");
        fs::write(&skill_file, "-".repeat(MAX_DISCOVERY_FRONTMATTER_BYTES + 1)).unwrap();

        let error = read_direct_child_skill_frontmatter(&root, &skill_file).unwrap_err();

        assert!(error.contains("技能元数据过大"));
    }

    #[test]
    fn user_reads_frontmatter_from_skill_with_large_body_for_discovery() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("skills");
        let skill_dir = root.join("large-body");
        fs::create_dir_all(&skill_dir).unwrap();
        let skill_file = skill_dir.join("SKILL.md");
        fs::write(
            &skill_file,
            format!(
                "---\nname: large-body\ndescription: Large body\n---\n{}",
                "x".repeat(MAX_DISCOVERY_FRONTMATTER_BYTES + 1)
            ),
        )
        .unwrap();

        let frontmatter = read_direct_child_skill_frontmatter(&root, &skill_file).unwrap();

        assert_eq!(
            frontmatter,
            "---\nname: large-body\ndescription: Large body\n---\n"
        );
    }

    #[test]
    fn user_rejects_oversized_skill_body_before_returning_content() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("skills");
        let skill_dir = root.join("big");
        fs::create_dir_all(&skill_dir).unwrap();
        let skill_file = skill_dir.join("SKILL.md");
        let large_body = "x".repeat((MAX_SKILL_CONTENT_BYTES as usize) + 1);
        fs::write(
            &skill_file,
            format!("---\nname: big\ndescription: Big\n---\n{}", large_body),
        )
        .unwrap();

        let error = read_direct_child_skill_file(&root, &skill_file).unwrap_err();

        assert!(error.contains("技能文件过大"));
    }

    #[tokio::test]
    async fn user_persists_disabled_skill_state_for_direct_user_skills_only() {
        let temp = tempfile::tempdir().unwrap();
        let database = DatabaseRuntime::initialize_for_tests(temp.path())
            .await
            .unwrap();
        let root = temp.path().join("skills");
        let skill_dir = write_skill(&root, "demo");
        let skill_file = skill_dir.join("SKILL.md");
        let nested_skill = write_skill(&skill_dir, "nested").join("SKILL.md");
        let roots = editable_skill_roots_at(temp.path(), &temp.path().join("shared"));
        for _ in 0..2 {
            set_disabled_skill_path(database.pool(), &roots, &skill_file, true)
                .await
                .unwrap();
        }
        assert_eq!(
            state::load(database.pool()).await.unwrap(),
            BTreeSet::from([SkillId::new(SkillRootScope::App, "demo".into()).unwrap()])
        );
        assert!(
            set_disabled_skill_path(database.pool(), &roots, &nested_skill, true)
                .await
                .is_err()
        );
        set_disabled_skill_path(database.pool(), &roots, &skill_file, false)
            .await
            .unwrap();
        assert!(state::load(database.pool()).await.unwrap().is_empty());
        assert!(skill_file.exists());
    }

    #[tokio::test]
    async fn user_failed_delete_preserves_disabled_skill_state() {
        let temp = tempfile::tempdir().unwrap();
        let database = DatabaseRuntime::initialize_for_tests(temp.path())
            .await
            .unwrap();
        let root = temp.path().join("skills");
        let skill_dir = write_skill(&root, "demo");
        let skill_file = skill_dir.join("SKILL.md");
        let roots = editable_skill_roots_at(temp.path(), &temp.path().join("shared"));
        set_disabled_skill_path(database.pool(), &roots, &skill_file, true)
            .await
            .unwrap();
        let error =
            delete_direct_child_skill_directory(database.pool(), &roots, &skill_dir, |_| {
                Err(std::io::Error::other("delete denied"))
            })
            .await
            .unwrap_err();
        assert!(error.contains("删除技能目录失败"));
        assert!(skill_dir.exists());
        assert_eq!(
            state::load(database.pool()).await.unwrap(),
            BTreeSet::from([SkillId::new(SkillRootScope::App, "demo".into()).unwrap()])
        );
    }

    #[tokio::test]
    async fn user_successful_delete_clears_disabled_skill_state() {
        let temp = tempfile::tempdir().unwrap();
        let database = DatabaseRuntime::initialize_for_tests(temp.path())
            .await
            .unwrap();
        let root = temp.path().join("skills");
        let skill_dir = write_skill(&root, "demo");
        let skill_file = skill_dir.join("SKILL.md");
        let roots = editable_skill_roots_at(temp.path(), &temp.path().join("shared"));
        set_disabled_skill_path(database.pool(), &roots, &skill_file, true)
            .await
            .unwrap();
        delete_direct_child_skill_directory(database.pool(), &roots, &skill_dir, |path| {
            fs::remove_dir_all(path)
        })
        .await
        .unwrap();
        assert!(!skill_dir.exists());
        assert!(state::load(database.pool()).await.unwrap().is_empty());
    }

    #[test]
    fn user_raw_skill_content_read_is_settings_window_only() {
        assert!(is_window_label_allowed(
            "settings",
            raw_skill_content_read_window_labels()
        ));
        assert!(!is_window_label_allowed(
            "main",
            raw_skill_content_read_window_labels()
        ));
    }

    #[test]
    fn user_enabled_skill_content_read_rejects_disabled_skills() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("skills");
        let skill_file = write_skill(&root, "demo").join("SKILL.md");
        let location = EditableSkillRoot {
            directory: root,
            scope: SkillRootScope::App,
        };
        let disabled = BTreeSet::from([SkillId::new(SkillRootScope::App, "demo".into()).unwrap()]);
        assert!(
            read_enabled_direct_child_skill_file(&location, &skill_file, &disabled)
                .unwrap_err()
                .contains("技能已禁用")
        );
    }

    #[test]
    fn user_enabled_skill_content_read_allows_enabled_skills() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("skills");
        let skill_file = write_skill(&root, "demo").join("SKILL.md");
        let location = EditableSkillRoot {
            directory: root,
            scope: SkillRootScope::App,
        };
        assert!(
            read_enabled_direct_child_skill_file(&location, &skill_file, &BTreeSet::new())
                .unwrap()
                .contains("name: demo")
        );
    }

    #[tokio::test]
    async fn user_keeps_all_disabled_skills_when_updates_arrive_together() {
        let temp = tempfile::tempdir().unwrap();
        let database = DatabaseRuntime::initialize_for_tests(temp.path())
            .await
            .unwrap();
        let root = temp.path().join("skills");
        let one = write_skill(&root, "one").join("SKILL.md");
        let two = write_skill(&root, "two").join("SKILL.md");
        let roots = editable_skill_roots_at(temp.path(), &temp.path().join("shared"));
        let (first, second) = tokio::join!(
            set_disabled_skill_path(database.pool(), &roots, &one, true),
            set_disabled_skill_path(database.pool(), &roots, &two, true)
        );
        first.unwrap();
        second.unwrap();
        assert_eq!(state::load(database.pool()).await.unwrap().len(), 2);
    }
}
