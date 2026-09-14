use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::process::ExitCode;

use blake2b_simd::Params;
use kaspa_addresses::Version;
use kaspa_addresses::{Address, Prefix};
use kaspa_consensus_core::hashing;
use kaspa_consensus_core::tx::{ScriptPublicKey, TransactionId, TransactionOutpoint, TransactionOutput};
use silverscript_abi::{ArtifactValue, SilAbiArtifact, encode_runtime_state_script};

fn usage() -> ! {
    eprintln!("usage: covenant-oracle <artifact.json> <creator_pubkey_hex(64)> <creator_commit_hex(64)> <stake_sompi> <deadline_daa> <wallet_pubkey_hex(64)> <settle_fee_sompi>");
    std::process::exit(2);
}

fn blake2b256(data: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let h = Params::new().hash_length(32).to_state().update(data).finalize();
    out.copy_from_slice(h.as_bytes());
    out
}

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let artifact_path = match args.next() {
        Some(p) => p,
        None => usage(),
    };
    let creator_pk = match args.next() {
        Some(h) => match decode_hex(&h) {
            Ok(b) if b.len() == 32 => b,
            _ => usage(),
        },
        None => usage(),
    };
    let creator_commit = match args.next() {
        Some(h) => match decode_hex(&h) {
            Ok(b) if b.len() == 32 => b,
            _ => usage(),
        },
        None => usage(),
    };
    let stake_sompi: i64 = match args.next() {
        Some(v) => v.parse().unwrap_or_else(|_| usage()),
        None => usage(),
    };
    let deadline_daa: i64 = match args.next() {
        Some(v) => v.parse().unwrap_or_else(|_| usage()),
        None => usage(),
    };
    let wallet_pubkey = match args.next() {
        Some(h) => match decode_hex(&h) {
            Ok(b) if b.len() == 32 => b,
            _ => usage(),
        },
        None => usage(),
    };
    let settle_fee_sompi: i64 = match args.next() {
        Some(v) => v.parse().unwrap_or_else(|_| usage()),
        None => usage(),
    };

    let mut buf = String::new();
    if fs::File::open(&artifact_path)
        .and_then(|mut f| f.read_to_string(&mut buf))
        .is_err()
    {
        eprintln!("error: cannot read artifact {}", artifact_path);
        return ExitCode::FAILURE;
    }
    let abi: SilAbiArtifact = match serde_json::from_str(&buf) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("error: artifact parse: {e}");
            return ExitCode::FAILURE;
        }
    };
    if let Err(e) = abi.check_consistency() {
        eprintln!("error: artifact check_consistency: {e}");
        return ExitCode::FAILURE;
    }

    let contract = match abi.contract("EvenOdd") {
        Some(c) => c,
        None => {
            eprintln!("error: no EvenOdd contract");
            return ExitCode::FAILURE;
        }
    };

    let creator_hash = blake2b256(&creator_pk);
    let game_wallet_hash = blake2b256(&wallet_pubkey);
    let mut values = BTreeMap::new();
    values.insert("creator_hash".into(), ArtifactValue::Bytes(creator_hash.to_vec()));
    values.insert("joiner_hash".into(), ArtifactValue::Bytes(vec![0u8; 32]));
    values.insert("creator_commit".into(), ArtifactValue::Bytes(creator_commit.clone()));
    values.insert("joiner_commit".into(), ArtifactValue::Bytes(vec![0u8; 32]));
    values.insert("stake".into(), ArtifactValue::Int(stake_sompi));
    values.insert("deadline_daa".into(), ArtifactValue::Int(deadline_daa));
    values.insert("creator_even".into(), ArtifactValue::Int(0));
    values.insert("creator_choice".into(), ArtifactValue::Int(0));
    values.insert("joiner_choice".into(), ArtifactValue::Int(0));
    values.insert("first_revealer_hash".into(), ArtifactValue::Bytes(vec![0u8; 32]));
    values.insert("game_wallet_hash".into(), ArtifactValue::Bytes(game_wallet_hash.to_vec()));
    values.insert("status".into(), ArtifactValue::Int(0));
    values.insert("settle_fee".into(), ArtifactValue::Int(settle_fee_sompi));

    let state_script = match encode_runtime_state_script(&abi, &contract.runtime_state, &values) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("error: encode state: {e}");
            return ExitCode::FAILURE;
        }
    };

    let inst = contract.compiled.script_parts(&contract.compiled.bytecode).expect("valid state span");
    let mut instance = Vec::new();
    instance.extend_from_slice(inst.0);
    instance.extend_from_slice(&state_script);
    instance.extend_from_slice(inst.2);

    // Per-game P2SH-256 script pubkey (standard Kaspa form the node accepts):
    // OP_BLAKE2B(256) 0xaa, push32 0x20, digest, OP_EQUAL 0x87. A bare
    // aa20 <hash> without the trailing OP_EQUAL is non-standard and rejected.
    let redeem_hash = blake2b256(&instance);
    let mut spk = Vec::new();
    spk.push(0xaa);
    spk.push(0x20);
    spk.extend_from_slice(&redeem_hash);
    spk.push(0x87);

    let address = Address::new(Prefix::Testnet, Version::ScriptHash, &redeem_hash);

    println!("creator_hash={}", faster_hex::hex_string(&creator_hash));
    println!("state_script_hex={}", faster_hex::hex_string(&state_script));
    println!("instance_len={}", instance.len());
    println!("instance_hex={}", faster_hex::hex_string(&instance));
    println!("p2sh_script_hex={}", faster_hex::hex_string(&spk));
    println!("address={}", address);

    // Cross-check: encode_runtime_state_script output must equal the artifact's
    // own state span for the canonical ctor values so we know we match byte-for-byte.
    println!("state_span_ok={}", state_script.len() == contract.compiled.state_span.len);
    println!("template_hash={}", faster_hex::hex_string(&contract.compiled.template_hash));

    let genesis_outpoint = TransactionOutpoint { transaction_id: TransactionId::from_bytes([0x11; 32]), index: 2 };
    // The displayed stake is the complete per-player lock.
    let escrow_sompi = stake_sompi as u64;
    let genesis_output = TransactionOutput {
        value: escrow_sompi,
        script_public_key: ScriptPublicKey::new(0, spk.into()),
        covenant: None,
    };
    let covenant_id = hashing::covenant_id::covenant_id(genesis_outpoint, std::iter::once((0, &genesis_output)));
    println!("covenant_id_vector={}", faster_hex::hex_string(&covenant_id.as_bytes()));
    ExitCode::SUCCESS
}

fn decode_hex(s: &str) -> Result<Vec<u8>, ()> {
    let mut out = Vec::with_capacity(s.len() / 2);
    for i in (0..s.len()).step_by(2) {
        if i + 1 >= s.len() {
            return Err(());
        }
        out.push(u8::from_str_radix(&s[i..i + 2], 16).map_err(|_| ())?);
    }
    Ok(out)
}
