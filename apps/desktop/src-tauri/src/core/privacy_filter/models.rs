use serde::{Deserialize, Serialize};

use super::{ModelFile, MODEL_DIRECTORY_NAME, MODEL_FILES, MODEL_REVISION};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq, Hash)]
pub enum PrivacyFilterModelId {
    #[default]
    #[serde(rename = "astrlink-guard-int8")]
    AstrLinkGuard,
    #[serde(rename = "openai-privacy-filter")]
    OpenAi,
    #[serde(rename = "openmed-privacy-filter")]
    OpenMed,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PrivacyFilterModelSource {
    #[default]
    Auto,
    Huggingface,
    HfMirror,
}

impl PrivacyFilterModelSource {
    pub fn urls(self, official: String) -> Vec<String> {
        let mirror = official.replacen("https://huggingface.co/", "https://hf-mirror.com/", 1);
        match self {
            Self::Auto => vec![official, mirror],
            Self::Huggingface => vec![official],
            Self::HfMirror => vec![mirror],
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyFilterModelInfo {
    pub id: PrivacyFilterModelId,
    pub name: &'static str,
    pub total_bytes: u64,
    pub supported: bool,
    pub recommended: bool,
    pub data_types: &'static [&'static str],
}

pub(super) struct ModelSpec {
    pub name: &'static str,
    pub repository: &'static str,
    pub revision: &'static str,
    pub prefix: &'static str,
    pub directory: &'static str,
    pub files: &'static [ModelFile],
}

const OPENAI_FILES: &[ModelFile] = &[ModelFile {
    name: "privacy-filter-q8.gguf",
    size: 1_637_572_192,
    sha256: "80efc1803eda7c095a79741d2008c07e2e0a57b01bac8825fbeb448fd097998c",
}];
const OPENMED_FILES: &[ModelFile] = &[ModelFile {
    name: "privacy-filter-multilingual-q8.gguf",
    size: 1_637_813_120,
    sha256: "968135172ba8202374b4c3bd7d353e100c8fc574035da793fa4d13ca441319b7",
}];
const ALL_DATA_TYPES: &[&str] = &[
    "email",
    "phone",
    "privatePerson",
    "privateAddress",
    "privateDate",
    "account",
    "paymentCard",
    "ipAddress",
    "url",
];
const OPENAI_DATA_TYPES: &[&str] = &[
    "email",
    "phone",
    "privatePerson",
    "privateAddress",
    "privateDate",
    "account",
    "paymentCard",
    "url",
];

impl PrivacyFilterModelId {
    pub(super) fn spec(self) -> ModelSpec {
        match self {
            Self::AstrLinkGuard => ModelSpec {
                name: "AstrLink Guard INT8",
                repository: "QuantumNous/astrlink-guard",
                revision: MODEL_REVISION,
                prefix: "int8/",
                directory: MODEL_DIRECTORY_NAME,
                files: MODEL_FILES,
            },
            Self::OpenAi => ModelSpec {
                name: "OpenAI Privacy Filter Q8",
                repository: "LocalAI-io/privacy-filter-GGUF",
                revision: "935d86882f4b5dc6e0eef05aae48ae5ba0a82a7a",
                prefix: "",
                directory: "openai-privacy-filter-80efc1803eda",
                files: OPENAI_FILES,
            },
            Self::OpenMed => ModelSpec {
                name: "OpenMed Privacy Filter Q8",
                repository: "LocalAI-io/privacy-filter-multilingual-GGUF",
                revision: "97a8fa7afd35eee8578594cbb6d4c8662faaba06",
                prefix: "",
                directory: "openmed-privacy-filter-968135172ba8",
                files: OPENMED_FILES,
            },
        }
    }

    pub fn needs_runtime(self) -> bool {
        self != Self::AstrLinkGuard
    }
}

impl ModelSpec {
    pub fn total_bytes(&self) -> u64 {
        self.files.iter().map(|file| file.size).sum()
    }

    pub fn urls(&self, file: ModelFile, source: PrivacyFilterModelSource) -> Vec<String> {
        source.urls(format!(
            "https://huggingface.co/{}/resolve/{}/{}{}",
            self.repository, self.revision, self.prefix, file.name
        ))
    }
}

pub fn catalog() -> Vec<PrivacyFilterModelInfo> {
    [
        PrivacyFilterModelId::AstrLinkGuard,
        PrivacyFilterModelId::OpenAi,
        PrivacyFilterModelId::OpenMed,
    ]
    .into_iter()
    .map(|id| {
        let spec = id.spec();
        PrivacyFilterModelInfo {
            id,
            name: spec.name,
            total_bytes: spec.total_bytes(),
            supported: !id.needs_runtime() || super::gguf::runtime_asset().is_some(),
            recommended: id == PrivacyFilterModelId::AstrLinkGuard,
            data_types: if id == PrivacyFilterModelId::OpenAi {
                OPENAI_DATA_TYPES
            } else {
                ALL_DATA_TYPES
            },
        }
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_selects_a_known_model_and_download_source_then_receives_only_its_pinned_files() {
        let model: PrivacyFilterModelId =
            serde_json::from_str("\"openmed-privacy-filter\"").expect("known model");
        let spec = model.spec();
        let urls = spec.urls(spec.files[0], PrivacyFilterModelSource::HfMirror);
        assert_eq!(urls, ["https://hf-mirror.com/LocalAI-io/privacy-filter-multilingual-GGUF/resolve/97a8fa7afd35eee8578594cbb6d4c8662faaba06/privacy-filter-multilingual-q8.gguf"]);
        assert!(serde_json::from_str::<PrivacyFilterModelId>("\"../../other-model\"").is_err());
        assert!(
            serde_json::from_str::<PrivacyFilterModelSource>("\"https://untrusted.test\"").is_err()
        );
    }

    #[test]
    fn user_opens_the_model_library_then_sees_astrlink_first_and_recommended() {
        let models = catalog();
        assert_eq!(models.len(), 3);
        assert_eq!(models[0].id, PrivacyFilterModelId::AstrLinkGuard);
        assert!(models[0].recommended);
        assert_eq!(models.iter().filter(|model| model.recommended).count(), 1);
    }
}
