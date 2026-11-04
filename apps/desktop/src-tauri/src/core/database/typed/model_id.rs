// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Stable model-id candidate expansion shared by metadata matching.

use std::collections::{HashMap, VecDeque};

const MAX_DEPTH: usize = 6;
const DATE_SUFFIX_LENGTHS: [usize; 4] = [11, 9, 7, 5];
const NAMED_SUFFIX_LENGTHS: [usize; 3] = [7, 8, 4];

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Candidate {
    pub value: String,
    pub depth: usize,
}

fn is_ascii_digits(value: &[u8]) -> bool {
    value.iter().all(u8::is_ascii_digit)
}

fn has_date_suffix(candidate: &str, suffix_len: usize, shape: &[usize]) -> bool {
    if candidate.len() <= suffix_len {
        return false;
    }
    let suffix = &candidate[candidate.len() - suffix_len..];
    let mut offset = 0;
    for digits in shape {
        if suffix.as_bytes().get(offset) != Some(&b'-') {
            return false;
        }
        offset += 1;
        let end = offset + digits;
        if end > suffix.len() || !is_ascii_digits(&suffix.as_bytes()[offset..end]) {
            return false;
        }
        offset = end;
    }
    offset == suffix.len()
}

fn strip_suffix(candidate: &str) -> Option<String> {
    for (length, shape) in
        DATE_SUFFIX_LENGTHS
            .into_iter()
            .zip([&[4usize, 2, 2][..], &[8], &[6], &[4]])
    {
        if has_date_suffix(candidate, length, shape) {
            return Some(candidate[..candidate.len() - length].to_string());
        }
    }

    for (suffix, length) in ["-latest", "-preview", "-exp"]
        .into_iter()
        .zip(NAMED_SUFFIX_LENGTHS)
    {
        if candidate.ends_with(suffix) {
            return Some(candidate[..candidate.len() - length].to_string());
        }
    }

    None
}

fn next_candidates(candidate: &str) -> Vec<String> {
    let mut next = Vec::new();
    if let Some(stripped) = strip_suffix(candidate) {
        next.push(stripped);
    }

    if let Some(index) = candidate.find('/') {
        if index > 0 {
            next.push(candidate[index + 1..].to_string());
        }
    }

    for (prefix, strip_length) in [("auto-", 5), ("any-", 4)] {
        if candidate.starts_with(prefix) && candidate.len() > strip_length {
            next.push(candidate[strip_length..].to_string());
        }
    }

    next
}

pub(crate) fn expand(model_id: &str) -> Vec<Candidate> {
    let root = model_id.to_ascii_lowercase();
    let mut best = HashMap::from([(root.clone(), 0usize)]);
    let mut queue = VecDeque::from([Candidate {
        value: root,
        depth: 0,
    }]);

    while let Some(current) = queue.pop_front() {
        if current.depth >= MAX_DEPTH {
            continue;
        }
        for candidate in next_candidates(&current.value) {
            let depth = current.depth + 1;
            if best.get(&candidate).is_some_and(|known| *known <= depth) {
                continue;
            }
            best.insert(candidate.clone(), depth);
            queue.push_back(Candidate {
                value: candidate,
                depth,
            });
        }
    }

    let mut candidates = best
        .into_iter()
        .map(|(value, depth)| Candidate { value, depth })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        left.depth
            .cmp(&right.depth)
            .then_with(|| left.value.cmp(&right.value))
    });
    candidates
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_gets_grouped_route_prefixes_stripped_in_depth_order() {
        let candidates = expand("group/auto-gpt-5-6-sol");
        let target = candidates
            .iter()
            .find(|candidate| candidate.value == "gpt-5-6-sol")
            .expect("candidate");
        assert_eq!(target.depth, 2);
    }
}
