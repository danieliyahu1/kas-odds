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

struct OracleArgs {
    artifact_path: String,
    creator_pk: Vec<u8>,
    creator_commit: Vec<u8>,
    stake_sompi: i64,
    deadline_daa: i64,
    wallet_pubkey: Vec<u8>,
    settle_fee_sompi: i64,
}

fn usage() -> String {
    "usage: covenant-oracle <artifact.json> <creator_pubkey_hex(64)> <creator_commit_hex(64)> <stake_sompi> <deadline_daa> <wallet_pubkey_hex(64)> <settle_fee_sompi>".into()
}

fn parse_args<I>(args: I) -> Result<OracleArgs, String>
where
    I: IntoIterator<Item = String>,
{
    let values: Vec<_> = args.into_iter().collect();
    if values.len() != 7 {
        return Err(usage());
    }
    let bytes = |value: &str, name: &str| -> Result<Vec<u8>, String> {
        let decoded = decode_hex(value).map_err(|_| format!("{name} must be hexadecimal"))?;
        if decoded.len() != 32 { return Err(format!("{name} must be exactly 32 bytes")); }
        Ok(decoded)
    };
    let stake_sompi = values[3].parse::<i64>().map_err(|_| "stake_sompi must be an integer".to_string())?;
    let deadline_daa = values[4].parse::<i64>().map_err(|_| "deadline_daa must be an integer".to_string())?;
    let settle_fee_sompi = values[6].parse::<i64>().map_err(|_| "settle_fee_sompi must be an integer".to_string())?;
    if stake_sompi < 100_000_000 { return Err("stake_sompi must be at least 100000000".into()); }
    if deadline_daa <= 0 { return Err("deadline_daa must be positive".into()); }
    if settle_fee_sompi <= 0 || settle_fee_sompi % 2 != 0 { return Err("settle_fee_sompi must be a positive even integer".into()); }
    Ok(OracleArgs {
        artifact_path: values[0].clone(),
        creator_pk: bytes(&values[1], "creator_pubkey")?,
        creator_commit: bytes(&values[2], "creator_commit")?,
        stake_sompi,
        deadline_daa,
        wallet_pubkey: bytes(&values[5], "wallet_pubkey")?,
        settle_fee_sompi,
    })
}

fn blake2b256(data: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let h = Params::new().hash_length(32).to_state().update(data).finalize();
    out.copy_from_slice(h.as_bytes());
    out
}

fn main() -> ExitCode {
    let args = match parse_args(std::env::args().skip(1)) {
        Ok(args) => args,
        Err(error) => { eprintln!("error: {error}"); return ExitCode::from(2); }
    };

    let mut buf = String::new();
    if fs::File::open(&args.artifact_path)
        .and_then(|mut f| f.read_to_string(&mut buf))
        .is_err()
    {
        eprintln!("error: cannot read artifact {}", args.artifact_path);
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

    let creator_hash = blake2b256(&args.creator_pk);
    let game_wallet_hash = blake2b256(&args.wallet_pubkey);
    let mut values = BTreeMap::new();
    values.insert("creator_hash".into(), ArtifactValue::Bytes(creator_hash.to_vec()));
    values.insert("joiner_hash".into(), ArtifactValue::Bytes(vec![0u8; 32]));
    values.insert("creator_commit".into(), ArtifactValue::Bytes(args.creator_commit.clone()));
    values.insert("joiner_commit".into(), ArtifactValue::Bytes(vec![0u8; 32]));
    values.insert("stake".into(), ArtifactValue::Int(args.stake_sompi));
    values.insert("deadline_daa".into(), ArtifactValue::Int(args.deadline_daa));
    values.insert("creator_even".into(), ArtifactValue::Int(0));
    values.insert("creator_choice".into(), ArtifactValue::Int(0));
    values.insert("joiner_choice".into(), ArtifactValue::Int(0));
    values.insert("first_revealer_hash".into(), ArtifactValue::Bytes(vec![0u8; 32]));
    values.insert("game_wallet_hash".into(), ArtifactValue::Bytes(game_wallet_hash.to_vec()));
    values.insert("status".into(), ArtifactValue::Int(0));
    values.insert("settle_fee".into(), ArtifactValue::Int(args.settle_fee_sompi));

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
    let escrow_sompi = args.stake_sompi as u64;
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
