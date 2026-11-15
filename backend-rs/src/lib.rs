//! Library entry point — exposes modules for integration tests.
pub mod application;
mod atomic_file;
pub mod auth;
pub mod config;
pub mod database_encryption;
pub mod db;
pub mod error;
pub mod models;
pub mod routers;
pub mod security;
pub mod ssh;
pub mod startup;
pub mod vault;
