use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

pub const RECORDS_CHANGED_EVENT: &str = "privacy-filter-records-changed";
pub const MAX_RECORDS: usize = 200;
pub const RETENTION_DAYS: u64 = 30;
pub const MAX_DETAIL_RECORDS: usize = 20;
pub const MAX_DETAIL_BYTES: usize = 64 * 1024;
const MAX_DETAIL_VALUES: usize = 200;
const MAX_DETAIL_TEXTS: usize = 20;
const RECORDS_FILE_NAME: &str = "records.json";
const RECORDS_VERSION: u8 = 1;
const DAY_MILLIS: u64 = 24 * 60 * 60 * 1_000;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PrivacyProtectionMode {
    Rules,
    Model,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum PrivacyProtectionOutcome {
    Protected,
    Blocked,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum PrivacyProtectionKind {
    Secret,
    Email,
    Phone,
    PrivatePerson,
    PrivateAddress,
    PrivateDate,
    Account,
    PaymentCard,
    IpAddress,
    Url,
    Custom,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivacyProtectionCategory {
    pub kind: PrivacyProtectionKind,
    pub count: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivacyProtectionRecordInput {
    pub mode: PrivacyProtectionMode,
    pub outcome: PrivacyProtectionOutcome,
    pub masked_count: u32,
    pub categories: Vec<PrivacyProtectionCategory>,
    /// Conversation and model labels stay optional so records written by older builds still load.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_name: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyProtectionRecord {
    pub id: String,
    pub created_at: u64,
    #[serde(flatten)]
    pub summary: PrivacyProtectionRecordInput,
}

/// Direction is an IPC view concern; the version-1 disk format remains unchanged.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyProtectionEntry {
    #[serde(flatten)]
    pub record: PrivacyProtectionRecord,
    pub direction: &'static str,
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum PrivacyProtectionRuleId {
    PrivateKey,
    ApiKey,
    Jwt,
    SecretAssignment,
    UrlPassword,
    Email,
    Phone,
    ChinaId,
    PaymentCard,
    CustomPrefix,
    CustomWord,
    LocalModel,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivacyProtectionRuleMatch {
    pub id: PrivacyProtectionRuleId,
    pub count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<super::models::PrivacyFilterModelId>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivacyProtectionValue {
    pub kind: PrivacyProtectionKind,
    pub original: String,
    pub placeholder: String,
    pub count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matches: Option<Vec<PrivacyProtectionRuleMatch>>,
}

// Content never enters StoredRecords, including during summary rollback or pruning.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivacyProtectionDetails {
    pub values: Vec<PrivacyProtectionValue>,
    pub texts: Vec<String>,
    pub truncated: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredRecords {
    version: u8,
    records: Vec<PrivacyProtectionRecord>,
}

struct RecordsState {
    generation: u64,
    records: Vec<PrivacyProtectionRecord>,
    restorations: Vec<PrivacyProtectionRecord>,
    details: HashMap<String, PrivacyProtectionDetails>,
}

pub struct PrivacyProtectionRecords {
    path: Option<PathBuf>,
    state: Mutex<RecordsState>,
}

impl Default for PrivacyProtectionRecords {
    fn default() -> Self {
        Self::new(None)
    }
}

impl PrivacyProtectionRecords {
    pub fn new(path: Option<PathBuf>) -> Self {
        let (records, prune_expired) = match path.as_deref() {
            Some(path) if path.exists() => match load(path) {
                Some(records) => {
                    let mut records = records;
                    match now_millis() {
                        Ok(now) => {
                            let before = records.len();
                            prune(&mut records, now);
                            let pruned = before != records.len();
                            (records, pruned)
                        }
                        Err(error) => {
                            log::warn!(
                                "Keeping privacy protection records without expiry check: {error}"
                            );
                            (records, false)
                        }
                    }
                }
                None => {
                    log::warn!(
                        "Ignoring unreadable privacy protection records at {}",
                        path.display()
                    );
                    (Vec::new(), false)
                }
            },
            _ => (Vec::new(), false),
        };
        let store = Self {
            path,
            state: Mutex::new(RecordsState {
                generation: 0,
                records,
                restorations: Vec::new(),
                details: HashMap::new(),
            }),
        };
        if let Ok(mut state) = store.state.lock() {
            if prune_expired {
                if let Err(error) = store.persist(&state.records) {
                    log::warn!("Could not prune expired privacy protection records: {error}");
                }
            }
            state.records.shrink_to_fit();
        }
        store
    }

    pub fn default_path() -> Result<PathBuf, String> {
        Ok(crate::core::system::paths::app_directory_path(
            crate::core::system::paths::AppDirectory::Data,
        )?
        .join("privacy-filter")
        .join(RECORDS_FILE_NAME))
    }

    #[cfg(test)]
    pub fn append(
        &self,
        summary: PrivacyProtectionRecordInput,
    ) -> Result<PrivacyProtectionRecord, String> {
        self.append_with_details(summary, None)
    }

    #[cfg(test)]
    pub fn append_with_details(
        &self,
        summary: PrivacyProtectionRecordInput,
        details: Option<PrivacyProtectionDetails>,
    ) -> Result<PrivacyProtectionRecord, String> {
        self.append_at_generation(summary, details, None)?
            .ok_or_else(|| "Privacy record generation changed".to_string())
    }

    pub fn generation(&self) -> Result<u64, String> {
        self.state
            .lock()
            .map(|state| state.generation)
            .map_err(|_| "Privacy protection records are unavailable".to_string())
    }

    pub fn append_at_generation(
        &self,
        summary: PrivacyProtectionRecordInput,
        details: Option<PrivacyProtectionDetails>,
        generation: Option<u64>,
    ) -> Result<Option<PrivacyProtectionRecord>, String> {
        validate_summary(&summary)?;
        if let Some(details) = &details {
            validate_details(details, &summary)?;
        }
        let record = PrivacyProtectionRecord {
            id: uuid::Uuid::new_v4().to_string(),
            created_at: now_millis()?,
            summary,
        };
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Privacy protection records are unavailable".to_string())?;
        let previous = state.records.clone();
        if generation.is_some_and(|expected| expected != state.generation) {
            return Ok(None);
        }
        state.records.insert(0, record.clone());
        prune(&mut state.records, record.created_at);
        if let Err(error) = self.persist(&state.records) {
            state.records = previous;
            return Err(error);
        }
        if let Some(details) = details {
            state.details.insert(record.id.clone(), details);
        }
        prune_details(&mut state);
        Ok(Some(record))
    }

    pub fn list(&self) -> Result<Vec<PrivacyProtectionRecord>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Privacy protection records are unavailable".to_string())?;
        let previous = state.records.clone();
        let now = now_millis()?;
        prune(&mut state.records, now);
        prune(&mut state.restorations, now);
        if previous.len() != state.records.len() {
            if let Err(error) = self.persist(&state.records) {
                state.records = previous;
                return Err(error);
            }
        }
        prune_details(&mut state);
        Ok(state.records.clone())
    }

    #[cfg(test)]
    pub fn append_restoration(
        &self,
        summary: PrivacyProtectionRecordInput,
        details: PrivacyProtectionDetails,
    ) -> Result<PrivacyProtectionRecord, String> {
        self.append_restoration_at_generation(summary, details, None)?
            .ok_or_else(|| "Privacy record generation changed".to_string())
    }

    pub fn append_restoration_at_generation(
        &self,
        summary: PrivacyProtectionRecordInput,
        details: PrivacyProtectionDetails,
        generation: Option<u64>,
    ) -> Result<Option<PrivacyProtectionRecord>, String> {
        validate_summary(&summary)?;
        if summary.outcome != PrivacyProtectionOutcome::Protected {
            return Err("A blocked request cannot have a restored reply".to_string());
        }
        validate_details(&details, &summary)?;
        let record = PrivacyProtectionRecord {
            id: uuid::Uuid::new_v4().to_string(),
            created_at: now_millis()?,
            summary,
        };
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Privacy protection records are unavailable".to_string())?;
        if generation.is_some_and(|expected| expected != state.generation) {
            return Ok(None);
        }
        state.restorations.insert(0, record.clone());
        prune(&mut state.restorations, record.created_at);
        state.details.insert(record.id.clone(), details);
        prune_details(&mut state);
        Ok(Some(record))
    }

    pub fn entries(&self) -> Result<Vec<PrivacyProtectionEntry>, String> {
        let outgoing = self.list()?;
        let state = self
            .state
            .lock()
            .map_err(|_| "Privacy protection records are unavailable".to_string())?;
        let mut entries: Vec<_> = state
            .restorations
            .iter()
            .cloned()
            .map(|record| PrivacyProtectionEntry {
                record,
                direction: "restore",
            })
            .chain(outgoing.into_iter().map(|record| PrivacyProtectionEntry {
                record,
                direction: "mask",
            }))
            .collect();
        entries.sort_by(|left, right| right.record.created_at.cmp(&left.record.created_at));
        entries.truncate(MAX_RECORDS);
        Ok(entries)
    }

    /// Ids whose concrete details are still held in memory; used to hide disclosure controls
    /// for records that can no longer be expanded.
    pub fn detail_ids(&self) -> Result<Vec<String>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Privacy protection records are unavailable".to_string())?;
        prune_details(&mut state);
        Ok(state.details.keys().cloned().collect())
    }

    pub fn details(&self, record_id: &str) -> Result<Option<PrivacyProtectionDetails>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Privacy protection records are unavailable".to_string())?;
        let cutoff = retention_cutoff(now_millis()?);
        if !state
            .records
            .iter()
            .chain(state.restorations.iter())
            .any(|record| record.id == record_id && record.created_at >= cutoff)
        {
            state.details.remove(record_id);
            return Ok(None);
        }
        Ok(state.details.get(record_id).cloned())
    }

    pub fn clear(&self) -> Result<u64, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Privacy protection records are unavailable".to_string())?;
        let previous = state.records.clone();
        state.records.clear();
        if let Err(error) = self.persist(&state.records) {
            state.records = previous;
            return Err(error);
        }
        state.details.clear();
        state.restorations.clear();
        state.generation += 1;
        Ok(state.generation)
    }

    fn persist(&self, records: &[PrivacyProtectionRecord]) -> Result<(), String> {
        let Some(path) = self.path.as_deref() else {
            return Ok(());
        };
        let parent = path
            .parent()
            .ok_or_else(|| "Privacy protection records have no parent directory".to_string())?;
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create privacy records directory: {error}"))?;
        let payload = serde_json::to_vec(&StoredRecords {
            version: RECORDS_VERSION,
            records: records.to_vec(),
        })
        .map_err(|error| format!("Could not serialize privacy protection records: {error}"))?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent)
            .map_err(|error| format!("Could not create privacy protection records: {error}"))?;
        temporary
            .write_all(&payload)
            .map_err(|error| format!("Could not write privacy protection records: {error}"))?;
        temporary
            .as_file_mut()
            .flush()
            .map_err(|error| format!("Could not flush privacy protection records: {error}"))?;
        temporary
            .as_file_mut()
            .sync_all()
            .map_err(|error| format!("Could not sync privacy protection records: {error}"))?;
        temporary
            .persist(path)
            .map_err(|error| format!("Could not save privacy protection records: {error}"))?;
        Ok(())
    }
}

fn validate_summary(summary: &PrivacyProtectionRecordInput) -> Result<(), String> {
    let mut kinds = HashSet::new();
    let count = summary.categories.iter().try_fold(0u32, |sum, category| {
        if category.count == 0 || !kinds.insert(category.kind) {
            return None;
        }
        sum.checked_add(category.count)
    });
    if summary.categories.len() > 11
        || count != Some(summary.masked_count)
        || summary.masked_count > 1_000_000
        || (summary.masked_count == 0 && summary.outcome == PrivacyProtectionOutcome::Protected)
    {
        return Err("Invalid privacy protection summary".to_string());
    }
    if summary.session_id.is_some_and(|id| id <= 0) {
        return Err("Invalid privacy protection summary".to_string());
    }
    if summary.model_name.as_deref().is_some_and(|name| {
        name.trim().is_empty() || name.chars().count() > 200 || name.chars().any(char::is_control)
    }) {
        return Err("Invalid privacy protection summary".to_string());
    }
    Ok(())
}

fn validate_details(
    details: &PrivacyProtectionDetails,
    summary: &PrivacyProtectionRecordInput,
) -> Result<(), String> {
    let invalid = || "Invalid privacy protection details".to_string();
    if details.values.len() > MAX_DETAIL_VALUES || details.texts.len() > MAX_DETAIL_TEXTS {
        return Err(invalid());
    }
    let mut placeholders = HashSet::new();
    let mut counts = HashMap::<PrivacyProtectionKind, u32>::new();
    let mut bytes = 0usize;
    for value in &details.values {
        if value.original.is_empty()
            || value.count == 0
            || value.placeholder.len() > 128
            || !value.placeholder.starts_with("{{")
            || !value.placeholder.ends_with("}}")
            || !placeholders.insert(&value.placeholder)
        {
            return Err(invalid());
        }
        let rule_bytes = validate_rule_matches(value, details.truncated)?;
        bytes = bytes
            .checked_add(value.original.len())
            .and_then(|sum| sum.checked_add(value.placeholder.len()))
            .and_then(|sum| sum.checked_add(rule_bytes))
            .ok_or_else(invalid)?;
        let count = counts.entry(value.kind).or_default();
        *count = count.checked_add(value.count).ok_or_else(invalid)?;
    }
    for text in &details.texts {
        if text.is_empty() {
            return Err(invalid());
        }
        bytes = bytes.checked_add(text.len()).ok_or_else(invalid)?;
    }
    if bytes > MAX_DETAIL_BYTES
        || counts.iter().any(|(kind, count)| {
            !summary
                .categories
                .iter()
                .any(|category| category.kind == *kind && *count <= category.count)
        })
        || (!details.truncated
            && summary
                .categories
                .iter()
                .any(|category| counts.get(&category.kind).copied().unwrap_or(0) != category.count))
    {
        return Err(invalid());
    }
    Ok(())
}

fn validate_rule_matches(value: &PrivacyProtectionValue, truncated: bool) -> Result<usize, String> {
    let Some(matches) = &value.matches else {
        return Ok(0);
    };
    let invalid = || "Invalid privacy protection rule matches".to_string();
    if matches.is_empty() || matches.len() > MAX_DETAIL_VALUES {
        return Err(invalid());
    }
    let mut identities = HashSet::new();
    let mut count = 0u32;
    for hit in matches {
        let parameter_is_valid = match hit.id {
            PrivacyProtectionRuleId::CustomPrefix | PrivacyProtectionRuleId::CustomWord => {
                hit.value.as_ref().is_some_and(|parameter| {
                    !parameter.is_empty() && parameter.len() <= MAX_DETAIL_BYTES
                }) && hit.model_id.is_none()
            }
            PrivacyProtectionRuleId::LocalModel => hit.model_id.is_some() && hit.value.is_none(),
            _ => hit.value.is_none() && hit.model_id.is_none(),
        };
        let expected_kind = match hit.id {
            PrivacyProtectionRuleId::Email => Some(PrivacyProtectionKind::Email),
            PrivacyProtectionRuleId::Phone => Some(PrivacyProtectionKind::Phone),
            PrivacyProtectionRuleId::ChinaId => Some(PrivacyProtectionKind::Account),
            PrivacyProtectionRuleId::PaymentCard => Some(PrivacyProtectionKind::PaymentCard),
            PrivacyProtectionRuleId::CustomPrefix | PrivacyProtectionRuleId::CustomWord => {
                Some(PrivacyProtectionKind::Custom)
            }
            PrivacyProtectionRuleId::LocalModel => None,
            _ => Some(PrivacyProtectionKind::Secret),
        };
        if hit.count == 0
            || !parameter_is_valid
            || expected_kind.is_some_and(|kind| kind != value.kind)
            || !identities.insert((hit.id, hit.value.as_deref(), hit.model_id))
        {
            return Err(invalid());
        }
        count = count.checked_add(hit.count).ok_or_else(invalid)?;
    }
    if count > value.count || (!truncated && count != value.count) {
        return Err(invalid());
    }
    serde_json::to_vec(matches)
        .map(|payload| payload.len())
        .map_err(|_| invalid())
}

fn prune_details(state: &mut RecordsState) {
    let mut entries: Vec<_> = state
        .restorations
        .iter()
        .chain(state.records.iter())
        .collect();
    entries.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    let recent: HashSet<_> = entries
        .into_iter()
        .take(MAX_DETAIL_RECORDS)
        .map(|record| record.id.as_str())
        .collect();
    state.details.retain(|id, _| recent.contains(id.as_str()));
}

fn now_millis() -> Result<u64, String> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Privacy protection clock is unavailable".to_string())?
        .as_millis() as u64)
}

fn retention_cutoff(now: u64) -> u64 {
    now.saturating_sub(RETENTION_DAYS * DAY_MILLIS)
}

fn prune(records: &mut Vec<PrivacyProtectionRecord>, now: u64) {
    let cutoff = retention_cutoff(now);
    records.retain(|record| record.created_at >= cutoff);
    records.truncate(MAX_RECORDS);
}

fn load(path: &Path) -> Option<Vec<PrivacyProtectionRecord>> {
    let content = std::fs::read(path).ok()?;
    let stored = serde_json::from_slice::<StoredRecords>(&content).ok()?;
    if stored.version != RECORDS_VERSION {
        return None;
    }
    let mut records = stored.records;
    if records
        .iter()
        .any(|record| validate_summary(&record.summary).is_err())
    {
        return None;
    }
    records.sort_unstable_by(|left, right| right.created_at.cmp(&left.created_at));
    Some(records)
}

#[cfg(test)]
mod tests {
    use super::{PrivacyProtectionRecordInput, PrivacyProtectionRecords, MAX_RECORDS};
    use serde_json::json;
    use std::fs;

    fn protected_request() -> PrivacyProtectionRecordInput {
        serde_json::from_value(json!({
            "mode": "rules", "outcome": "protected", "maskedCount": 2,
            "categories": [{"kind": "email", "count": 2}]
        }))
        .expect("valid protection summary")
    }

    fn temporary_path() -> (tempfile::TempDir, std::path::PathBuf) {
        let root = tempfile::tempdir().expect("temp dir");
        let path = root.path().join("privacy-filter").join("records.json");
        (root, path)
    }

    fn protected_details() -> super::PrivacyProtectionDetails {
        serde_json::from_value(json!({
            "values": [{"kind": "email", "original": "alice@example.test", "placeholder": "{{EMAIL_0123456789abcdef}}", "count": 2}],
            "texts": ["Email {{EMAIL_0123456789abcdef}} twice"],
            "truncated": false
        })).expect("valid memory-only details")
    }

    #[test]
    fn user_clears_history_then_late_writes_cannot_restore_old_records_or_details() {
        let records = PrivacyProtectionRecords::default();
        let old = records.generation().expect("generation");
        let current = records.clear().expect("clear");
        assert!(records
            .append_at_generation(protected_request(), Some(protected_details()), Some(old))
            .expect("stale mask")
            .is_none());
        assert!(records
            .append_restoration_at_generation(protected_request(), protected_details(), Some(old))
            .expect("stale restoration")
            .is_none());
        assert!(records.entries().expect("entries").is_empty());
        assert!(records.detail_ids().expect("details").is_empty());
        assert!(records
            .append_at_generation(
                protected_request(),
                Some(protected_details()),
                Some(current)
            )
            .expect("new request")
            .is_some());
    }

    #[test]
    fn user_restores_a_reply_then_sees_one_reverse_record_without_changing_disk_summaries_and_can_clear_both(
    ) {
        let (_root, path) = temporary_path();
        let records = PrivacyProtectionRecords::new(Some(path.clone()));
        let outgoing = records
            .append_with_details(protected_request(), Some(protected_details()))
            .expect("outgoing");
        let before = fs::read(&path).expect("stored summary");
        let reply = records
            .append_restoration(protected_request(), protected_details())
            .expect("restored response");
        let entries = records.entries().expect("entries");
        let json = serde_json::to_value(entries).expect("IPC entries");
        assert_eq!(json.as_array().expect("rows").len(), 2);
        assert_eq!(
            json.as_array()
                .expect("rows")
                .iter()
                .find(|row| row["id"] == reply.id)
                .expect("reply")["direction"],
            "restore"
        );
        assert_eq!(fs::read(&path).expect("unchanged disk"), before);
        assert!(records.details(&reply.id).expect("reply details").is_some());
        let reopened = PrivacyProtectionRecords::new(Some(path));
        assert_eq!(reopened.entries().expect("reopened").len(), 1);
        assert_eq!(reopened.list().expect("old summary")[0].id, outgoing.id);
        records.clear().expect("clear");
        assert!(records.entries().expect("cleared").is_empty());
        assert!(records
            .details(&reply.id)
            .expect("cleared details")
            .is_none());
    }

    #[test]
    fn user_browses_recent_requests_then_sees_their_labels_and_only_memory_backed_rows_can_expand()
    {
        let (_root, path) = temporary_path();
        let records = PrivacyProtectionRecords::new(Some(path.clone()));
        let labelled = records
            .append_with_details(
                serde_json::from_value(json!({
                    "mode": "rules", "outcome": "protected", "maskedCount": 2,
                    "categories": [{"kind": "email", "count": 2}],
                    "sessionId": 7, "modelName": "Example Model"
                }))
                .expect("valid labelled summary"),
                Some(protected_details()),
            )
            .expect("record with concrete details");
        let summary_only = records.append(protected_request()).expect("summary record");

        let listed = records.list().expect("records");
        let labelled_row = listed
            .iter()
            .find(|record| record.id == labelled.id)
            .expect("labelled record");
        assert_eq!(labelled_row.summary.session_id, Some(7));
        assert_eq!(
            labelled_row.summary.model_name.as_deref(),
            Some("Example Model")
        );
        assert_eq!(
            records.detail_ids().expect("detail ids"),
            vec![labelled.id.clone()]
        );
        assert!(!records
            .detail_ids()
            .expect("detail ids")
            .contains(&summary_only.id));

        let restarted = PrivacyProtectionRecords::new(Some(path));
        let restored = restarted.list().expect("records after restart");
        assert_eq!(
            restored
                .iter()
                .find(|record| record.id == labelled.id)
                .expect("restored labels")
                .summary
                .model_name
                .as_deref(),
            Some("Example Model")
        );
        assert!(restarted
            .detail_ids()
            .expect("no details after restart")
            .is_empty());
    }

    #[test]
    fn user_reads_captured_rule_matches_in_memory_without_persisting_custom_rules_or_losing_legacy_details(
    ) {
        let (_root, path) = temporary_path();
        let records = PrivacyProtectionRecords::new(Some(path.clone()));
        let details = serde_json::from_value::<super::PrivacyProtectionDetails>(json!({
            "values": [{"kind": "email", "original": "alice@example.test", "placeholder": "{{EMAIL_0123456789abcdef}}", "count": 2,
                "matches": [{"id": "email", "count": 1}, {"id": "localModel", "modelId": "astrlink-guard-int8", "count": 1}]}],
            "texts": [], "truncated": false
        })).expect("captured rules are accepted");
        let entry = records
            .append_with_details(protected_request(), Some(details))
            .expect("record with real matches");
        let details = serde_json::to_value(
            records
                .details(&entry.id)
                .expect("details")
                .expect("recent details"),
        )
        .expect("IPC payload");
        assert_eq!(details["values"][0]["matches"][0]["id"], "email");
        assert_eq!(
            details["values"][0]["matches"][1]["modelId"],
            "astrlink-guard-int8"
        );
        let stored = fs::read_to_string(&path).expect("summary on disk");
        assert!(!stored.contains("matches"));
        assert!(!stored.contains("astrlink-guard-int8"));
        let old = records
            .append_with_details(protected_request(), Some(protected_details()))
            .expect("legacy detail still accepted");
        assert!(records.details(&old.id).expect("legacy details").is_some());
    }

    #[test]
    fn user_rejects_inconsistent_or_fabricated_rule_metadata_without_losing_a_valid_record() {
        let records = PrivacyProtectionRecords::default();
        let first = records
            .append_with_details(protected_request(), Some(protected_details()))
            .expect("valid record");
        for matches in [
            json!([{"id": "email", "count": 0}]),
            json!([{"id": "email", "count": 3}]),
            json!([{"id": "email", "count": 1}, {"id": "email", "count": 1}]),
            json!([{"id": "localModel", "count": 2}]),
            json!([{"id": "customWord", "count": 2}]),
            json!([{"id": "phone", "count": 2}]),
            json!([{"id": "email", "value": "made up", "count": 2}]),
        ] {
            let details = serde_json::from_value::<super::PrivacyProtectionDetails>(json!({
                "values": [{"kind": "email", "original": "alice@example.test", "placeholder": "{{EMAIL_0123456789abcdef}}", "count": 2, "matches": matches}],
                "texts": [], "truncated": false
            })).expect("valid payload shape");
            assert!(records
                .append_with_details(protected_request(), Some(details))
                .is_err());
        }
        assert_eq!(records.list().expect("previous record stays").len(), 1);
        assert!(records
            .details(&first.id)
            .expect("previous details stay")
            .is_some());
    }

    #[test]
    fn user_reads_concrete_replacements_from_memory_but_only_summaries_survive_restart() {
        let (_root, path) = temporary_path();
        let records = PrivacyProtectionRecords::new(Some(path.clone()));
        let record = records
            .append_with_details(protected_request(), Some(protected_details()))
            .expect("protected request");
        let details = records
            .details(&record.id)
            .expect("details lookup")
            .expect("recent details");
        assert_eq!(details.values[0].original, "alice@example.test");
        assert_eq!(details.values[0].count, 2);
        assert_eq!(details.texts[0], "Email {{EMAIL_0123456789abcdef}} twice");
        let on_disk = fs::read_to_string(&path).expect("summary on disk");
        assert!(!on_disk.contains("alice@example.test"));
        assert!(!on_disk.contains("{{EMAIL_"));
        let saved: serde_json::Value =
            serde_json::from_str(&on_disk).expect("unchanged stored format");
        assert_eq!(saved["version"], 1);
        assert!(saved["records"][0].get("values").is_none());
        assert!(saved["records"][0].get("texts").is_none());
        let reopened = PrivacyProtectionRecords::new(Some(path));
        assert_eq!(reopened.list().expect("surviving summary")[0].id, record.id);
        assert!(reopened
            .details(&record.id)
            .expect("details after restart")
            .is_none());
    }

    #[test]
    fn user_keeps_only_recent_concrete_content_and_clearing_removes_it_without_affecting_future_requests(
    ) {
        let records = PrivacyProtectionRecords::default();
        let first = records
            .append_with_details(protected_request(), Some(protected_details()))
            .expect("first request");
        for _ in 0..super::MAX_DETAIL_RECORDS {
            records
                .append_with_details(protected_request(), Some(protected_details()))
                .expect("recent request");
        }
        assert!(records
            .details(&first.id)
            .expect("evicted details")
            .is_none());
        let summaries = records.list().expect("all summaries");
        assert_eq!(summaries.len(), super::MAX_DETAIL_RECORDS + 1);
        let latest_id = &summaries[0].id;
        assert!(records
            .details(latest_id)
            .expect("latest details")
            .is_some());
        records.clear().expect("clear records");
        assert!(records
            .details(latest_id)
            .expect("cleared details")
            .is_none());
        let next = records
            .append_with_details(protected_request(), Some(protected_details()))
            .expect("new request");
        assert!(records.details(&next.id).expect("new details").is_some());
    }

    #[test]
    fn user_rejects_oversized_or_inconsistent_details_and_can_still_record_valid_content() {
        let records = PrivacyProtectionRecords::default();
        let mut oversized = protected_details();
        oversized.values[0].original = "名".repeat(super::MAX_DETAIL_BYTES);
        assert!(records
            .append_with_details(protected_request(), Some(oversized))
            .is_err());
        let mut inconsistent = protected_details();
        inconsistent.values[0].count = 3;
        assert!(records
            .append_with_details(protected_request(), Some(inconsistent))
            .is_err());
        assert!(records.list().expect("no invalid summary").is_empty());
        let next = records
            .append_with_details(protected_request(), Some(protected_details()))
            .expect("valid request");
        assert!(records.details(&next.id).expect("valid details").is_some());
    }

    #[test]
    fn user_keeps_existing_summaries_and_details_when_a_save_or_clear_fails_then_can_retry() {
        let (_root, path) = temporary_path();
        let records = PrivacyProtectionRecords::new(Some(path.clone()));
        let first = records
            .append_with_details(protected_request(), Some(protected_details()))
            .expect("first request");
        let backup = path.with_extension("backup");
        fs::rename(&path, &backup).expect("keep valid test summary");
        fs::create_dir(&path).expect("simulate unavailable destination");
        assert!(records
            .append_with_details(protected_request(), Some(protected_details()))
            .is_err());
        assert!(records.clear().is_err());
        let visible = records.list().expect("previous summary remains");
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].id, first.id);
        assert_eq!(
            records
                .details(&first.id)
                .expect("previous details")
                .expect("details retained")
                .values[0]
                .original,
            "alice@example.test"
        );
        fs::remove_dir(&path).expect("restore test destination");
        fs::rename(backup, &path).expect("restore valid test summary");
        records.clear().expect("retry clearing");
        assert!(records
            .details(&first.id)
            .expect("cleared details")
            .is_none());
        assert!(records.list().expect("cleared summaries").is_empty());
    }

    #[test]
    fn user_rejects_duplicate_replacements_and_overlong_detail_lists_without_losing_existing_records(
    ) {
        let records = PrivacyProtectionRecords::default();
        let first = records
            .append_with_details(protected_request(), Some(protected_details()))
            .expect("first request");
        let mut duplicated = protected_details();
        duplicated.values.push(duplicated.values[0].clone());
        assert!(records
            .append_with_details(protected_request(), Some(duplicated))
            .is_err());
        let mut too_many_texts = protected_details();
        too_many_texts.texts = vec!["masked text".to_string(); super::MAX_DETAIL_TEXTS + 1];
        assert!(records
            .append_with_details(protected_request(), Some(too_many_texts))
            .is_err());
        let mut too_many_values = protected_details();
        too_many_values.values =
            vec![too_many_values.values[0].clone(); super::MAX_DETAIL_VALUES + 1];
        assert!(records
            .append_with_details(protected_request(), Some(too_many_values))
            .is_err());
        assert_eq!(records.list().expect("valid record retained").len(), 1);
        assert!(records
            .details(&first.id)
            .expect("valid details retained")
            .is_some());
    }

    #[test]
    fn user_sees_the_latest_two_hundred_summaries_after_restart_and_can_clear_them() {
        let (_root, path) = temporary_path();
        let records = PrivacyProtectionRecords::new(Some(path.clone()));
        let first = records.append(protected_request()).expect("first request");
        for _ in 0..MAX_RECORDS {
            records
                .append(protected_request())
                .expect("protected request");
        }
        let latest = records.append(protected_request()).expect("latest request");
        let reopened = PrivacyProtectionRecords::new(Some(path.clone()));
        let visible = reopened.list().expect("records");
        assert_eq!(visible.len(), MAX_RECORDS);
        assert_eq!(visible[0].id, latest.id);
        assert!(visible.iter().all(|entry| entry.id != first.id));
        reopened.clear().expect("clear records");
        assert!(PrivacyProtectionRecords::new(Some(path))
            .list()
            .expect("records after restart")
            .is_empty());
        reopened
            .append(protected_request())
            .expect("recording continues after clearing");
        assert_eq!(reopened.list().expect("new records").len(), 1);
    }

    #[test]
    fn user_keeps_only_thirty_days_and_older_summaries_are_removed_from_disk() {
        let (_root, path) = temporary_path();
        fs::create_dir_all(path.parent().expect("parent")).expect("directory");
        let expired = json!({
            "version": 1,
            "records": [{
                "id": "expired", "createdAt": 0, "mode": "rules", "outcome": "protected",
                "maskedCount": 1, "categories": [{"kind": "email", "count": 1}]
            }, {
                "id": "current", "createdAt": super::now_millis().expect("clock"), "mode": "model",
                "outcome": "protected", "maskedCount": 2,
                "categories": [{"kind": "phone", "count": 2}]
            }]
        });
        fs::write(&path, serde_json::to_vec(&expired).expect("serialize")).expect("write records");
        let records = PrivacyProtectionRecords::new(Some(path.clone()));
        let visible = records.list().expect("records");
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].id, "current");
        let saved = fs::read_to_string(path).expect("records are persisted");
        assert!(!saved.contains("expired"));
    }

    #[test]
    fn user_records_a_protected_request_without_retaining_raw_values_or_accepting_inconsistent_counts(
    ) {
        assert!(
            serde_json::from_value::<PrivacyProtectionRecordInput>(json!({
                "mode": "rules", "outcome": "protected", "maskedCount": 1,
                "categories": [{"kind": "email", "count": 1}], "original": "alice@example.test"
            }))
            .is_err()
        );
        let records = PrivacyProtectionRecords::default();
        let mut input = protected_request();
        input.masked_count = 3;
        assert!(records.append(input).is_err());
        assert!(records.list().expect("no invalid record").is_empty());
        let saved = records
            .append(protected_request())
            .expect("valid request still records");
        let value = serde_json::to_value(saved).expect("record can be read by the UI");
        assert_eq!(value["maskedCount"], 2);
        assert_eq!(value["categories"][0]["kind"], "email");
        assert!(value.get("original").is_none());
    }

    #[test]
    fn user_does_not_overwrite_an_unreadable_records_file_at_startup_and_replaces_it_when_a_summary_is_recorded(
    ) {
        let (_root, path) = temporary_path();
        fs::create_dir_all(path.parent().expect("parent")).expect("directory");
        fs::write(&path, b"{ this is not a records file").expect("write corrupt records");
        let records = PrivacyProtectionRecords::new(Some(path.clone()));

        assert!(records
            .list()
            .expect("empty list while unreadable")
            .is_empty());
        assert_eq!(
            fs::read(&path).expect("corrupt file is still there"),
            b"{ this is not a records file"
        );

        records.append(protected_request()).expect("a new summary");
        assert!(serde_json::from_slice::<serde_json::Value>(
            &fs::read(&path).expect("records were replaced")
        )
        .is_ok());
    }
}
