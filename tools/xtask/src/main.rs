//! xtask — NATS Studio repository automation (see docs/architecture, section 14).
//!
//! Usage: `cargo xtask <check-layers|verify-tools|gen-types|sync-version>`
//!
//! The canonical home for repo automation so that CI and every developer run the
//! exact same checks. `check-layers` is the load-bearing one: it turns the
//! architecture's layered/acyclic crate graph and single-import confinement rules
//! into an enforced build gate.
#![forbid(unsafe_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use anyhow::{bail, Context, Result};

fn main() -> ExitCode {
    let cmd = std::env::args().nth(1).unwrap_or_default();
    let result = match cmd.as_str() {
        "check-layers" => check_layers(),
        "verify-tools" => verify_tools(),
        "gen-types" => gen_types(),
        "sync-version" => sync_version(),
        "" | "help" | "-h" | "--help" => {
            print_help();
            return ExitCode::SUCCESS;
        }
        other => {
            eprintln!("xtask: unknown subcommand `{other}`\n");
            print_help();
            return ExitCode::from(2);
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("xtask {cmd}: error: {err:#}");
            ExitCode::FAILURE
        }
    }
}

fn print_help() {
    eprintln!(
        "xtask — NATS Studio repo automation\n\n\
         SUBCOMMANDS:\n  \
         check-layers   Enforce the acyclic layered crate graph + single-import confinement\n  \
         verify-tools   Check external tool versions against tools/versions.toml\n  \
         gen-types      Regenerate the TS bindings from ns-types via typeshare\n  \
         sync-version   Verify the app version is consistent across manifests"
    );
}

// ---------------------------------------------------------------------------
// Architecture model (kept in lockstep with docs/architecture/dependency-graph.md)
// ---------------------------------------------------------------------------

/// Foundation crates reachable from any layer (they never depend "back"), like std.
fn is_foundation(name: &str) -> bool {
    matches!(name, "ns-types" | "ns-core" | "ns-event")
}

/// Dev/tooling crates exempt from the layering rule (still cycle-checked).
fn is_exempt(name: &str) -> bool {
    matches!(name, "ns-testkit" | "xtask")
}

/// Architectural layer of each crate. `None` = unknown → forces this map to stay current.
fn layer_of(name: &str) -> Option<u8> {
    Some(match name {
        "ns-types" | "ns-core" => 0,
        "ns-event" | "ns-nats" | "ns-security" | "ns-storage" | "ns-telemetry" | "ns-inspector"
        | "ns-testkit" => 1,
        "ns-connection" | "ns-pubsub" | "ns-jetstream" | "ns-monitor" | "ns-subject"
        | "ns-terminal" | "ns-plugin" => 2,
        "ns-dashboard" | "ns-ipc" => 3,
        "nats-studio" => 4,
        "xtask" => 99,
        _ => return None,
    })
}

/// External crates confined to specific owner crates (single-import confinement, spine 5.2.6).
fn confinement() -> BTreeMap<&'static str, &'static [&'static str]> {
    BTreeMap::from([
        ("async-nats", &["ns-nats"][..]),
        ("rusqlite", &["ns-storage"][..]),
        ("keyring", &["ns-security"][..]),
        ("reqwest", &["ns-monitor"][..]),
        ("portable-pty", &["ns-terminal"][..]),
        ("tauri", &["ns-ipc", "nats-studio"][..]),
    ])
}

struct CrateInfo {
    name: String,
    deps: Vec<String>,
}

fn check_layers() -> Result<()> {
    let root = workspace_root()?;
    let crates = load_crates(&root)?;
    let names: BTreeSet<&str> = crates.iter().map(|c| c.name.as_str()).collect();
    let mut violations: Vec<String> = Vec::new();

    // Every crate must have an assigned layer (keeps the map honest as crates are added).
    for c in &crates {
        if layer_of(&c.name).is_none() {
            violations.push(format!(
                "crate `{}` has no layer in xtask::layer_of — update the map",
                c.name
            ));
        }
    }

    // Layering: depend only on strictly-lower layers, plus foundation (types/core/event).
    for c in &crates {
        if is_exempt(&c.name) {
            continue;
        }
        let Some(lc) = layer_of(&c.name) else {
            continue;
        };
        for d in &c.deps {
            if !names.contains(d.as_str()) || is_foundation(d) {
                continue;
            }
            let Some(ld) = layer_of(d) else { continue };
            if ld >= lc {
                violations.push(format!(
                    "layering: `{}` (L{lc}) depends on `{}` (L{ld}) — only strictly-lower layers \
                     or foundation (types/core/event) are allowed",
                    c.name, d
                ));
            }
        }
    }

    // Single-import confinement: heavyweight deps only in their owner crate(s).
    let conf = confinement();
    for c in &crates {
        for d in &c.deps {
            if let Some(owners) = conf.get(d.as_str()) {
                if !owners.contains(&c.name.as_str()) {
                    violations.push(format!(
                        "confinement: `{}` directly depends on `{}` — only [{}] may (spine 5.2.6)",
                        c.name,
                        d,
                        owners.join(", ")
                    ));
                }
            }
        }
    }

    // Acyclicity over intra-workspace edges.
    let adj: BTreeMap<&str, Vec<&str>> = crates
        .iter()
        .map(|c| {
            let out = c
                .deps
                .iter()
                .filter(|d| names.contains(d.as_str()))
                .map(String::as_str)
                .collect();
            (c.name.as_str(), out)
        })
        .collect();
    if let Some(cycle) = find_cycle(&adj) {
        violations.push(format!("dependency cycle: {}", cycle.join(" -> ")));
    }

    if violations.is_empty() {
        println!(
            "check-layers: OK — {} crates, graph is acyclic and correctly layered",
            crates.len()
        );
        Ok(())
    } else {
        for v in &violations {
            eprintln!("  x {v}");
        }
        bail!("{} layering/confinement violation(s)", violations.len())
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Visit {
    New,
    Active,
    Done,
}

fn find_cycle<'a>(adj: &BTreeMap<&'a str, Vec<&'a str>>) -> Option<Vec<&'a str>> {
    let mut state: BTreeMap<&'a str, Visit> = adj.keys().map(|k| (*k, Visit::New)).collect();
    let mut stack: Vec<&'a str> = Vec::new();
    let keys: Vec<&'a str> = adj.keys().copied().collect();
    for k in keys {
        if matches!(state.get(&k), Some(Visit::New)) {
            if let Some(cycle) = dfs_cycle(k, adj, &mut state, &mut stack) {
                return Some(cycle);
            }
            stack.clear();
        }
    }
    None
}

fn dfs_cycle<'a>(
    node: &'a str,
    adj: &BTreeMap<&'a str, Vec<&'a str>>,
    state: &mut BTreeMap<&'a str, Visit>,
    stack: &mut Vec<&'a str>,
) -> Option<Vec<&'a str>> {
    state.insert(node, Visit::Active);
    stack.push(node);
    if let Some(neighbours) = adj.get(node) {
        for &n in neighbours {
            match state.get(&n).copied().unwrap_or(Visit::Done) {
                Visit::Active => {
                    let pos = stack.iter().position(|&x| x == n).unwrap_or(0);
                    let mut cyc = stack[pos..].to_vec();
                    cyc.push(n);
                    return Some(cyc);
                }
                Visit::New => {
                    if let Some(cyc) = dfs_cycle(n, adj, state, stack) {
                        return Some(cyc);
                    }
                }
                Visit::Done => {}
            }
        }
    }
    stack.pop();
    state.insert(node, Visit::Done);
    None
}

// ---------------------------------------------------------------------------
// verify-tools / gen-types / sync-version
// ---------------------------------------------------------------------------

fn verify_tools() -> Result<()> {
    let root = workspace_root()?;
    let path = root.join("tools/versions.toml");
    let text = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    let val: toml::Value = text.parse()?;
    let tools = val
        .get("tools")
        .and_then(|t| t.as_table())
        .context("[tools] table missing")?;

    let mut mismatched = 0usize;
    let mut missing = 0usize;
    for (name, spec) in tools {
        let version = spec.get("version").and_then(|v| v.as_str()).unwrap_or("");
        let Some(bin) = spec.get("bin").and_then(|b| b.as_str()) else {
            println!("  - {name}: pinned {version} (no binary check)");
            continue;
        };
        let args: Vec<String> = spec
            .get("args")
            .and_then(|a| a.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_else(|| vec!["--version".into()]);
        match Command::new(bin).args(&args).output() {
            Ok(out) => {
                let combined = format!(
                    "{}{}",
                    String::from_utf8_lossy(&out.stdout),
                    String::from_utf8_lossy(&out.stderr)
                );
                if combined.contains(version) {
                    println!("  ok {name}: {version}");
                } else {
                    println!("  x  {name}: expected {version}, got `{}`", combined.trim());
                    mismatched += 1;
                }
            }
            Err(_) => {
                println!("  !  {name}: `{bin}` not found on PATH (pinned {version})");
                missing += 1;
            }
        }
    }

    if mismatched > 0 {
        bail!("{mismatched} tool version mismatch(es) ({missing} missing)");
    }
    if missing > 0 {
        println!("note: {missing} tool(s) missing — install per tools/versions.toml");
    }
    println!("verify-tools: OK");
    Ok(())
}

fn gen_types() -> Result<()> {
    let root = workspace_root()?;
    let out = root.join("packages/ns-bindings/src/generated/types.ts");
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent)?;
    }
    let status = Command::new("typeshare")
        .arg(root.join("crates/ns-types"))
        .arg("--lang")
        .arg("typescript")
        .arg("--output-file")
        .arg(&out)
        .status()
        .context("run typeshare (is typeshare-cli installed? `cargo install typeshare-cli`)")?;
    if !status.success() {
        bail!("typeshare exited with failure");
    }
    println!("gen-types: wrote {}", out.display());
    Ok(())
}

fn sync_version() -> Result<()> {
    let root = workspace_root()?;
    let text = fs::read_to_string(root.join("Cargo.toml"))?;
    let val: toml::Value = text.parse()?;
    let version = val
        .get("workspace")
        .and_then(|w| w.get("package"))
        .and_then(|p| p.get("version"))
        .and_then(|v| v.as_str())
        .context("workspace.package.version missing")?;
    println!("app version (source of truth): {version}");

    let needle = format!("\"version\": \"{version}\"");
    let mut mismatches = 0usize;
    for (label, rel) in [
        ("tauri.conf.json", "apps/desktop/src-tauri/tauri.conf.json"),
        ("package.json", "apps/desktop/package.json"),
    ] {
        let p = root.join(rel);
        if p.is_file() {
            let s = fs::read_to_string(&p)?;
            if s.contains(&needle) {
                println!("  ok {label} matches");
            } else {
                println!("  x  {label} does not contain version {version}");
                mismatches += 1;
            }
        } else {
            println!("  - {label} not present yet");
        }
    }
    if mismatches > 0 {
        bail!("{mismatches} version mismatch(es)");
    }
    println!("sync-version: OK");
    Ok(())
}

// ---------------------------------------------------------------------------
// Workspace discovery / manifest parsing
// ---------------------------------------------------------------------------

fn workspace_root() -> Result<PathBuf> {
    if let Ok(cwd) = std::env::current_dir() {
        if let Some(root) = find_up(&cwd) {
            return Ok(root);
        }
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if let Some(root) = find_up(&manifest) {
        return Ok(root);
    }
    bail!("could not locate the workspace root (no Cargo.toml containing [workspace])")
}

fn find_up(start: &Path) -> Option<PathBuf> {
    let mut cur = Some(start);
    while let Some(dir) = cur {
        let manifest = dir.join("Cargo.toml");
        if manifest.is_file() {
            if let Ok(s) = fs::read_to_string(&manifest) {
                if s.contains("[workspace]") {
                    return Some(dir.to_path_buf());
                }
            }
        }
        cur = dir.parent();
    }
    None
}

fn load_crates(root: &Path) -> Result<Vec<CrateInfo>> {
    let root_text = fs::read_to_string(root.join("Cargo.toml"))?;
    let root_toml: toml::Value = root_text.parse().context("parse root Cargo.toml")?;
    let members = root_toml
        .get("workspace")
        .and_then(|w| w.get("members"))
        .and_then(|m| m.as_array())
        .context("[workspace].members missing")?;

    let mut dirs: Vec<PathBuf> = Vec::new();
    for m in members {
        let pat = m.as_str().context("member entry is not a string")?;
        if let Some(prefix) = pat.strip_suffix("/*") {
            let base = root.join(prefix);
            if let Ok(entries) = fs::read_dir(&base) {
                for e in entries.flatten() {
                    let p = e.path();
                    if p.join("Cargo.toml").is_file() {
                        dirs.push(p);
                    }
                }
            }
        } else {
            dirs.push(root.join(pat));
        }
    }

    let mut crates = Vec::new();
    for dir in dirs {
        let manifest = dir.join("Cargo.toml");
        let text = fs::read_to_string(&manifest)
            .with_context(|| format!("read {}", manifest.display()))?;
        let val: toml::Value = text
            .parse()
            .with_context(|| format!("parse {}", manifest.display()))?;
        let name = val
            .get("package")
            .and_then(|p| p.get("name"))
            .and_then(|n| n.as_str())
            .with_context(|| format!("no package.name in {}", manifest.display()))?
            .to_string();
        let deps = val
            .get("dependencies")
            .and_then(|d| d.as_table())
            .map(|t| t.keys().cloned().collect())
            .unwrap_or_default();
        crates.push(CrateInfo { name, deps });
    }
    crates.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(crates)
}
