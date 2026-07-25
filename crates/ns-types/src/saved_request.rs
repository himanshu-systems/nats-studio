//! Saved Requests contract: named publish/request templates the user can fire
//! with one click, plus the request/response DTOs for the `saved_requests_*`
//! commands.
//!
//! Reuses the same payload/encoding/header concepts as the Publisher and
//! Request-Reply views ([`PayloadEncoding`], [`MessageHeader`]) rather than
//! inventing a parallel shape — a template is just a named, persisted publish
//! or request.

use serde::{Deserialize, Serialize};
use typeshare::typeshare;

use crate::{MessageHeader, PayloadEncoding, U64};

/// How a saved template fires.
#[typeshare]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SavedRequestMode {
    Publish,
    Request,
}

/// A stored publish/request template (has an `id`).
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedRequestDto {
    pub id: String,
    pub name: String,
    pub subject: String,
    pub mode: SavedRequestMode,
    /// The raw text as typed, not yet encoded — mirrors the Publisher /
    /// Request-Reply compose form.
    pub payload: String,
    pub encoding: PayloadEncoding,
    pub headers: Vec<MessageHeader>,
    /// Only meaningful when `mode` is `Request`.
    pub timeout_ms: U64,
}

/// A template being created (no `id` yet).
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedRequestInput {
    pub name: String,
    pub subject: String,
    pub mode: SavedRequestMode,
    pub payload: String,
    pub encoding: PayloadEncoding,
    pub headers: Vec<MessageHeader>,
    pub timeout_ms: U64,
}

// --- request / response DTOs for saved_requests_* commands ---

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListSavedRequestsResponse {
    pub requests: Vec<SavedRequestDto>,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSavedRequestRequest {
    pub saved_request: SavedRequestInput,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSavedRequestRequest {
    pub saved_request: SavedRequestDto,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSavedRequestRequest {
    pub id: String,
}
