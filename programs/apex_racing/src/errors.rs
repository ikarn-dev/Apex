use anchor_lang::prelude::*;

#[error_code]
pub enum ApexError {
    #[msg("Unknown level id")]
    UnknownLevel,
    #[msg("Unknown car id")]
    UnknownCar,
    #[msg("Driver has not unlocked this car")]
    CarLocked,
    #[msg("Driver has not unlocked this level")]
    LevelLocked,
    #[msg("Session nonce does not match the driver profile")]
    NonceMismatch,
    #[msg("Session is not open")]
    SessionNotOpen,
    #[msg("Session has already finished")]
    SessionAlreadyFinished,
    #[msg("Session is not in a claimable state")]
    SessionNotClaimable,
    #[msg("Only the registered session signer may advance this session")]
    UnauthorizedSessionSigner,
    #[msg("Checkpoint index went backwards")]
    NonMonotonicCheckpoint,
    #[msg("Elapsed time went backwards")]
    NonMonotonicTime,
    #[msg("Drift delta exceeds the per-tick ceiling")]
    DriftDeltaTooLarge,
    #[msg("Submitted result is not physically plausible")]
    ImplausibleResult,
    #[msg("Session must be undelegated before claiming")]
    StillDelegated,
    #[msg("Replay hash is empty")]
    MissingReplayHash,
    #[msg("Drift target for this level was not met")]
    DriftTargetMissed,
    #[msg("Arithmetic overflow")]
    Overflow,
}
