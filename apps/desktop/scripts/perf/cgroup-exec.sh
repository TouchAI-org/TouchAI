#!/usr/bin/env bash
set +e

"$@"
status=$?

metrics_file="${TOUCHAI_PERF_CGROUP_METRICS:-}"
if [[ -n "$metrics_file" ]]; then
    cgroup_path="$(awk -F: 'END { print $3 }' /proc/self/cgroup)"
    cgroup_dir="/sys/fs/cgroup${cgroup_path}"
    {
        printf 'exit_code=%s\n' "$status"
        if [[ -r "$cgroup_dir/memory.peak" ]]; then
            printf 'memory_peak_bytes=%s\n' "$(cat "$cgroup_dir/memory.peak")"
        fi
        if [[ -r "$cgroup_dir/memory.swap.peak" ]]; then
            printf 'memory_swap_peak_bytes=%s\n' "$(cat "$cgroup_dir/memory.swap.peak")"
        fi
        if [[ -r "$cgroup_dir/cpu.stat" ]]; then
            sed 's/^/cpu_/' "$cgroup_dir/cpu.stat"
        fi
    } >"$metrics_file"
fi

exit "$status"
