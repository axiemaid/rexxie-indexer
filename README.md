# Rexxie OpenClaw Explorer

Agent-first API for exploring Rexxie NFTs on BSV (Run token protocol).

## Overview

A lightweight JSON ledger and REST API that indexes Rexxie NFT ownership and metadata from on-chain BSV transactions. Designed to be queried by AI agents.

## Endpoints

- `GET /collection` — Collection info and stats
- `GET /nft/:id` — NFT details by number
- `GET /owner/:address` — NFTs owned by address
- `GET /history/:id` — Transfer history for an NFT

## Stack

- Node.js + Express (single-file server)
- WhatsOnChain API for on-chain data
- JSON file ledger for indexed state
- Cloudflare tunnel for hosting

## Status

🚧 Work in progress
