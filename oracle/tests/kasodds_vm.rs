use std::collections::BTreeMap;
use std::fs;

use blake2b_simd::Params;
use kaspa_consensus_core::Hash;
use kaspa_consensus_core::hashing::sighash::SigHashReusedValuesUnsync;
use kaspa_consensus_core::mass::units::SigopCount;
use kaspa_consensus_core::subnets::SUBNETWORK_ID_NATIVE;
use kaspa_consensus_core::tx::{CovenantBinding, PopulatedTransaction, ScriptPublicKey, Transaction, TransactionId, TransactionInput, TransactionOutpoint, TransactionOutput, UtxoEntry, VerifiableTransaction};
use kaspa_txscript::caches::Cache;
use kaspa_txscript::covenants::CovenantsContext;
use kaspa_txscript::{EngineCtx, EngineFlags, TxScriptEngine, pay_to_script_hash_script, pay_to_script_hash_signature_script_with_flags};
use kaspa_txscript_errors::TxScriptError;
use secp256k1::{Keypair, Secp256k1, SecretKey};
use silverscript_abi::{ArtifactValue, SilAbiArtifact, encode_contract_entry_sig_script, encode_runtime_state_script};

// Protocol v10 economics: pots below 100 KAS pay the winner in full. Larger pots
// pay the winner 99% and the game wallet 1%; canceled games refund the full lock.
const STAKE: u64 = 100_000_000;
const ESCROW: u64 = STAKE;
const JOINED: u64 = STAKE + STAKE;
const WINNER: u64 = JOINED;
const FEE: u64 = 0;
const SETTLE_FEE: i64 = 1_600_000;
const DEADLINE_DAA: u64 = 500_000_000;

struct Player {
    pubkey: Vec<u8>,
    hash: Vec<u8>,
}

#[test]
fn vm_accepts_join_with_one_game_input_and_ordinary_funding() {
    let artifact = artifact();
    let creator = player(1);
    let joiner = player(2);
    let wallet = player(3);
    let creator_commit = vec![9; 32];
    let joiner_commit = vec![8; 32];
    let open = open_game_state(&artifact, &creator, &creator_commit, &wallet);
    let joined = game_state_with_commits(&artifact, 1, &creator, &joiner, 0, 0, &[], &creator_commit, &joiner_commit, &wallet);
    let open_script = instance_script(&artifact, &open);
    let joined_script = instance_script(&artifact, &joined);
    let covenant_id = Hash::from_bytes([0x33; 32]);
    let invocation = entry_sigscript(&artifact, "join", vec![ArtifactValue::Bytes(joiner.pubkey.clone()), ArtifactValue::Bytes(joiner_commit)], &open_script);
    let entries = vec![
        UtxoEntry::new(ESCROW, pay_to_script_hash_script(&open_script), DEADLINE_DAA, false, Some(covenant_id)),
        UtxoEntry::new(ESCROW, player_script(&joiner), DEADLINE_DAA, false, None),
    ];
    let output = TransactionOutput {
        value: JOINED,
        script_public_key: pay_to_script_hash_script(&joined_script),
        covenant: Some(CovenantBinding { authorizing_input: 0, covenant_id }),
    };
    let tx = Transaction::new(1, vec![tx_input(0, invocation), tx_input(1, vec![])], vec![output], 0, SUBNETWORK_ID_NATIVE, 0, vec![]);
    let result = execute_input(tx, entries, 0);
    assert!(result.is_ok(), "join should pass: {:?}", result.err());
}

#[test]
fn vm_accepts_signed_creator_refund_before_and_after_the_join_deadline() {
    let artifact = artifact();
    let creator = player(1);
    let joiner = player(2);
    let wallet = player(3);
    let open = open_game_state(&artifact, &creator, &vec![9; 32], &wallet);
    // The creator may sign the refund immediately, not only after the deadline.
    assert_signed_creator_refund(&artifact, &open, &creator, DEADLINE_DAA - 1, true);
    assert_signed_creator_refund(&artifact, &open, &creator, DEADLINE_DAA, true);
    // Only the creator can prove authorship; another key fails either way.
    assert_signed_creator_refund(&artifact, &open, &joiner, DEADLINE_DAA - 1, false);
    assert_signed_creator_refund(&artifact, &open, &joiner, DEADLINE_DAA, false);
}

#[test]
fn vm_rejects_a_sub_1_kas_stake() {
    let artifact = artifact();
    let creator = player(1);
    let wallet = player(3);
    // Every entry requires `stake >= 100000000`, so a sub-1-KAS instance can
    // never execute an entry — even the creator's own signed refund.
    let sub_stake = open_game_state_with_stake(&artifact, &creator, &vec![9; 32], &wallet, 99_999_999);
    assert_signed_creator_refund(&artifact, &sub_stake, &creator, DEADLINE_DAA, false);
    let one_kas = open_game_state_with_stake(&artifact, &creator, &vec![9; 32], &wallet, 100_000_000);
    assert_signed_creator_refund(&artifact, &one_kas, &creator, DEADLINE_DAA, true);
}

#[test]
fn vm_accepts_late_fallback_claim_and_rejects_early_or_wrong_revealer() {
    let artifact = artifact();
    let creator = player(1);
    let joiner = player(2);
    let wallet = player(3);
    let state = game_state(&artifact, 2, &creator, &joiner, 0, 0, &creator.hash, &wallet);
    assert_fallback_claim(&artifact, &state, &creator, &wallet, DEADLINE_DAA + 3_000, true);
    assert_fallback_claim(&artifact, &state, &creator, &wallet, DEADLINE_DAA + 2_999, false);
    assert_fallback_claim(&artifact, &state, &joiner, &wallet, DEADLINE_DAA + 3_000, false);
}

#[test]
fn vm_accepts_normal_reveals_and_rejects_invalid_reveals() {
    let artifact = artifact();
    let creator = player(1);
    let joiner = player(2);
    let wallet = player(3);
    let creator_nonce = vec![7; 32];
    let joiner_nonce = vec![8; 32];
    let joined = game_state_with_commits(&artifact, 1, &creator, &joiner, 0, 0, &[], &commitment(1, &creator_nonce), &commitment(0, &joiner_nonce), &wallet);
    let after_creator_reveal = game_state_with_commits(&artifact, 2, &creator, &joiner, 1, 0, &creator.hash, &commitment(1, &creator_nonce), &commitment(0, &joiner_nonce), &wallet);

    assert_reveal_spend(&artifact, &joined, &creator, &wallet, 1, &creator_nonce, &creator, Some(&after_creator_reveal), vec![], true);
    assert_reveal_spend(&artifact, &joined, &creator, &wallet, 0, &creator_nonce, &creator, Some(&after_creator_reveal), vec![], false);
    assert_reveal_spend(&artifact, &game_state(&artifact, 0, &creator, &joiner, 0, 0, &[], &wallet), &creator, &wallet, 1, &creator_nonce, &creator, None, vec![], false);
    assert_reveal_spend(&artifact, &after_creator_reveal, &creator, &wallet, 1, &creator_nonce, &creator, None, vec![], false);

    assert_reveal_spend(
        &artifact,
        &after_creator_reveal,
        &joiner,
        &wallet,
        0,
        &joiner_nonce,
        &joiner,
        None,
        vec![
            TransactionOutput { value: WINNER, script_public_key: ScriptPublicKey::new(0, vec![0x51].into()), covenant: None },
            TransactionOutput { value: FEE, script_public_key: ScriptPublicKey::new(0, vec![0x52].into()), covenant: None },
        ],
        false,
    );
    assert_reveal_spend(
        &artifact,
        &after_creator_reveal,
        &joiner,
        &wallet,
        0,
        &joiner_nonce,
        &joiner,
        None,
        vec![TransactionOutput { value: WINNER, script_public_key: player_script(&joiner), covenant: None }],
        true,
    );

    let even_joiner_nonce = vec![10; 32];
    let even_after_creator = game_state_with_commits(&artifact, 2, &creator, &joiner, 1, 0, &creator.hash, &commitment(1, &creator_nonce), &commitment(1, &even_joiner_nonce), &wallet);
    assert_reveal_spend(
        &artifact,
        &even_after_creator,
        &joiner,
        &wallet,
        1,
        &even_joiner_nonce,
        &creator,
        None,
        vec![TransactionOutput { value: WINNER, script_public_key: player_script(&creator), covenant: None }],
        true,
    );
}

fn assert_reveal_spend(artifact: &SilAbiArtifact, state_script: &[u8], player: &Player, wallet: &Player, choice: i64, nonce: &[u8], payout_player: &Player, continuation_state: Option<&[u8]>, outputs: Vec<TransactionOutput>, should_pass: bool) {
    let script = instance_script(artifact, state_script);
    let covenant_id = Hash::from_bytes([0x33; 32]);
    let invocation = entry_sigscript(artifact, "reveal", vec![ArtifactValue::Bytes(player.pubkey.clone()), ArtifactValue::Int(choice), ArtifactValue::Bytes(nonce.to_vec()), ArtifactValue::Bytes(payout_player.pubkey.clone()), ArtifactValue::Bytes(wallet.pubkey.clone())], &script);
    let entries = vec![
        UtxoEntry::new(JOINED, pay_to_script_hash_script(&script), DEADLINE_DAA, false, Some(covenant_id)),
        UtxoEntry::new(1_000_000, player_script(player), DEADLINE_DAA, false, None),
    ];
    let tx_outputs = if let Some(next_state) = continuation_state {
        let next_script = instance_script(artifact, next_state);
        vec![TransactionOutput {
            value: JOINED,
            script_public_key: pay_to_script_hash_script(&next_script),
            covenant: Some(CovenantBinding { authorizing_input: 0, covenant_id }),
        }]
    } else {
        outputs
    };
    let tx = Transaction::new(1, vec![tx_input(0, invocation), tx_input(1, vec![])], tx_outputs, 0, SUBNETWORK_ID_NATIVE, 0, vec![]);
    let result = execute_input(tx, entries, 0);
    if should_pass {
        assert!(result.is_ok(), "reveal should pass: {:?}", result.err());
    } else {
        assert!(matches!(result, Err(TxScriptError::VerifyError | TxScriptError::EvalFalse | TxScriptError::UnsatisfiedLockTime(_))), "reveal should fail by VM verify/eval false: {result:?}");
    }
}

fn assert_signed_creator_refund(artifact: &SilAbiArtifact, state_script: &[u8], creator: &Player, daa: u64, should_pass: bool) {
    let script = instance_script(artifact, state_script);
    let covenant_id = Hash::from_bytes([0x33; 32]);
    let invocation = entry_sigscript(artifact, "refund", vec![ArtifactValue::Bytes(creator.pubkey.clone())], &script);
    let entries = vec![
        UtxoEntry::new(ESCROW, pay_to_script_hash_script(&script), DEADLINE_DAA - 1, false, Some(covenant_id)),
        UtxoEntry::new(1_000_000, player_script(creator), DEADLINE_DAA - 1, false, None),
    ];
    let output = TransactionOutput {
        value: ESCROW,
        script_public_key: player_script(creator),
        covenant: None,
    };
    let tx = Transaction::new(1, vec![tx_input(0, invocation), tx_input(1, vec![])], vec![output], daa, SUBNETWORK_ID_NATIVE, 0, vec![]);
    let result = execute_input(tx, entries, 0);
    if should_pass {
        assert!(result.is_ok(), "creator refund should pass: {:?}", result.err());
    } else {
        assert!(matches!(result, Err(TxScriptError::VerifyError | TxScriptError::EvalFalse | TxScriptError::UnsatisfiedLockTime(_))), "creator refund should fail by VM verify/eval false: {result:?}");
    }
}

fn assert_fallback_claim(artifact: &SilAbiArtifact, state_script: &[u8], player: &Player, wallet: &Player, daa: u64, should_pass: bool) {
    let script = instance_script(artifact, state_script);
    let covenant_id = Hash::from_bytes([0x33; 32]);
    let invocation = entry_sigscript(artifact, "fallback_claim", vec![ArtifactValue::Bytes(player.pubkey.clone()), ArtifactValue::Bytes(wallet.pubkey.clone())], &script);
    let entries = vec![
        UtxoEntry::new(JOINED, pay_to_script_hash_script(&script), DEADLINE_DAA, false, Some(covenant_id)),
        UtxoEntry::new(1_000_000, player_script(player), DEADLINE_DAA, false, None),
    ];
    let outputs = vec![TransactionOutput { value: WINNER - SETTLE_FEE as u64, script_public_key: player_script(player), covenant: None }];
    let age_daa = daa.checked_sub(DEADLINE_DAA).expect("test daa is after input daa");
    let mut input = tx_input(0, invocation);
    input.sequence = age_daa;
    let tx = Transaction::new(1, vec![input, tx_input(1, vec![])], outputs, 0, SUBNETWORK_ID_NATIVE, 0, vec![]);
    let result = execute_input(tx, entries, 0);
    if should_pass {
        assert!(result.is_ok(), "fallback_claim should pass: {:?}", result.err());
    } else {
        assert!(matches!(result, Err(TxScriptError::VerifyError | TxScriptError::EvalFalse | TxScriptError::UnsatisfiedLockTime(_))), "fallback_claim should fail by VM verify/eval false: {result:?}");
    }
}

fn artifact() -> SilAbiArtifact {
    let raw = fs::read_to_string("../covenant/kasodds.template.artifact.json").expect("artifact readable");
    let artifact: SilAbiArtifact = serde_json::from_str(&raw).expect("artifact parses");
    artifact.check_consistency().expect("artifact is consistent");
    artifact
}

fn game_state(artifact: &SilAbiArtifact, status: i64, creator: &Player, joiner: &Player, creator_choice: i64, joiner_choice: i64, first_revealer_hash: &[u8], wallet: &Player) -> Vec<u8> {
    game_state_with_commits(artifact, status, creator, joiner, creator_choice, joiner_choice, first_revealer_hash, &vec![9; 32], &vec![8; 32], wallet)
}

fn game_state_with_commits(artifact: &SilAbiArtifact, status: i64, creator: &Player, joiner: &Player, creator_choice: i64, joiner_choice: i64, first_revealer_hash: &[u8], creator_commit: &[u8], joiner_commit: &[u8], wallet: &Player) -> Vec<u8> {
    let contract = artifact.contract("KasOdds").expect("KasOdds contract");
    let mut values = BTreeMap::new();
    values.insert("creator_hash".into(), ArtifactValue::Bytes(creator.hash.clone()));
    values.insert("joiner_hash".into(), ArtifactValue::Bytes(joiner.hash.clone()));
    values.insert("creator_commit".into(), ArtifactValue::Bytes(creator_commit.to_vec()));
    values.insert("joiner_commit".into(), ArtifactValue::Bytes(joiner_commit.to_vec()));
    values.insert("stake".into(), ArtifactValue::Int(STAKE as i64));
    values.insert("deadline_daa".into(), ArtifactValue::Int(DEADLINE_DAA as i64));
    values.insert("creator_even".into(), ArtifactValue::Int(1));
    values.insert("creator_choice".into(), ArtifactValue::Int(creator_choice));
    values.insert("joiner_choice".into(), ArtifactValue::Int(joiner_choice));
    values.insert("first_revealer_hash".into(), ArtifactValue::Bytes(if first_revealer_hash.is_empty() { vec![0; 32] } else { first_revealer_hash.to_vec() }));
    values.insert("game_wallet_hash".into(), ArtifactValue::Bytes(wallet.hash.clone()));
    values.insert("status".into(), ArtifactValue::Int(status));
    values.insert("settle_fee".into(), ArtifactValue::Int(SETTLE_FEE));
    encode_runtime_state_script(artifact, &contract.runtime_state, &values).expect("state encodes")
}

fn open_game_state(artifact: &SilAbiArtifact, creator: &Player, creator_commit: &[u8], wallet: &Player) -> Vec<u8> {
    open_game_state_with_stake(artifact, creator, creator_commit, wallet, STAKE as i64)
}

fn open_game_state_with_stake(artifact: &SilAbiArtifact, creator: &Player, creator_commit: &[u8], wallet: &Player, stake: i64) -> Vec<u8> {
    let contract = artifact.contract("KasOdds").expect("KasOdds contract");
    let mut values = BTreeMap::new();
    values.insert("creator_hash".into(), ArtifactValue::Bytes(creator.hash.clone()));
    values.insert("joiner_hash".into(), ArtifactValue::Bytes(vec![0; 32]));
    values.insert("creator_commit".into(), ArtifactValue::Bytes(creator_commit.to_vec()));
    values.insert("joiner_commit".into(), ArtifactValue::Bytes(vec![0; 32]));
    values.insert("stake".into(), ArtifactValue::Int(stake));
    values.insert("deadline_daa".into(), ArtifactValue::Int(DEADLINE_DAA as i64));
    values.insert("creator_even".into(), ArtifactValue::Int(1));
    values.insert("creator_choice".into(), ArtifactValue::Int(0));
    values.insert("joiner_choice".into(), ArtifactValue::Int(0));
    values.insert("first_revealer_hash".into(), ArtifactValue::Bytes(vec![0; 32]));
    values.insert("game_wallet_hash".into(), ArtifactValue::Bytes(wallet.hash.clone()));
    values.insert("status".into(), ArtifactValue::Int(0));
    values.insert("settle_fee".into(), ArtifactValue::Int(SETTLE_FEE));
    encode_runtime_state_script(artifact, &contract.runtime_state, &values).expect("state encodes")
}

fn commitment(choice: i64, nonce: &[u8]) -> Vec<u8> {
    let mut preimage = Vec::new();
    preimage.extend_from_slice(&choice.to_le_bytes());
    preimage.extend_from_slice(nonce);
    blake2b256(&preimage).to_vec()
}

fn player_script(player: &Player) -> ScriptPublicKey {
    let mut script = vec![0x20];
    script.extend_from_slice(&player.pubkey);
    script.push(0xac);
    ScriptPublicKey::new(0, script.into())
}

fn instance_script(artifact: &SilAbiArtifact, state_script: &[u8]) -> Vec<u8> {
    let (_, contract) = artifact.contracts.first_key_value().expect("single contract");
    let (prefix, _, suffix) = contract.compiled.script_parts(&contract.compiled.bytecode).expect("script parts");
    let mut out = Vec::new();
    out.extend_from_slice(prefix);
    out.extend_from_slice(state_script);
    out.extend_from_slice(suffix);
    out
}

fn entry_sigscript(artifact: &SilAbiArtifact, entry: &str, args: Vec<ArtifactValue>, script: &[u8]) -> Vec<u8> {
    let contract_name = artifact.contracts.first_key_value().expect("single contract").0;
    let call = encode_contract_entry_sig_script(artifact, contract_name, entry, &args).expect("entry encodes");
    pay_to_script_hash_signature_script_with_flags(script.to_vec(), call, EngineFlags { covenants_enabled: true, ..Default::default() }).expect("p2sh wraps")
}

fn tx_input(index: u32, signature_script: Vec<u8>) -> TransactionInput {
    TransactionInput {
        previous_outpoint: TransactionOutpoint { transaction_id: TransactionId::from_bytes([index as u8 + 1; 32]), index },
        signature_script,
        sequence: 0,
        compute_commit: SigopCount(20).into(),
    }
}

fn execute_input(tx: Transaction, entries: Vec<UtxoEntry>, input_idx: usize) -> Result<(), TxScriptError> {
    let reused_values = SigHashReusedValuesUnsync::new();
    let sig_cache = Cache::new(10_000);
    let input = tx.inputs[input_idx].clone();
    let populated = PopulatedTransaction::new(&tx, entries);
    let cov_ctx = CovenantsContext::from_tx(&populated).map_err(TxScriptError::from)?;
    let utxo = populated.utxo(input_idx).expect("selected input utxo");
    TxScriptEngine::from_transaction_input(
        &populated,
        &input,
        input_idx,
        utxo,
        EngineCtx::new(&sig_cache).with_reused(&reused_values).with_covenants_ctx(&cov_ctx),
        EngineFlags { covenants_enabled: true, ..Default::default() },
    ).execute()
}

fn player(seed: u8) -> Player {
    let secp = Secp256k1::new();
    let secret = SecretKey::from_slice(&[seed; 32]).expect("valid secret");
    let keypair = Keypair::from_secret_key(&secp, &secret);
    let (xonly, _) = keypair.x_only_public_key();
    let pubkey = xonly.serialize().to_vec();
    let hash = blake2b256(&pubkey).to_vec();
    Player { pubkey, hash }
}

fn blake2b256(data: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let h = Params::new().hash_length(32).to_state().update(data).finalize();
    out.copy_from_slice(h.as_bytes());
    out
}
