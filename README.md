# Glon

A protobuf-native actor OS.

Every entity is a single protobuf message. Every message is a durable actor.
Raw protobuf binary on disk, Rivet actors in the cloud. Two primitives, nothing else.

## The Primitive

```protobuf
message GlonObject {
  string id = 1;
  string kind = 2;
  string name = 3;
  bytes content = 4;
  map<string, string> meta = 5;
  int64 created_at = 6;
  int64 updated_at = 7;
  int64 size = 8;
}
```

One message type. A file is a GlonObject. A process is a GlonObject.
A config is a GlonObject. The proto schema itself is a GlonObject.
The `kind` field is the only distinction.

## How It Works

```
Disk                      Actors                   Shell
~/.glon/objects/*.pb  --> durable Rivet actors --> glon> /list
raw protobuf binary       in-memory + SQLite       CLI commands
```

**On disk**: each object is a `.pb` file containing raw protobuf wire-format bytes.
No JSON, no SQL wrapping, no filesystem metadata. The protobuf IS the file.

**In actors**: each object lives as a [Rivet actor](https://rivet.gg/docs/actors) --
stateful, durable, hibernatable. A store coordinator maintains a SQLite index for queries.

**Self-describing**: the OS bootstraps its own source code as objects. You can query
the OS for the code that built it.

## Quick Start

```bash
# Install
git clone https://github.com/Geep5/Glon.git
cd Glon
npm install

# Terminal 1: start the OS
npm run dev

# Terminal 2: seed source files (first time)
npm run bootstrap

# Terminal 3: open the shell
npm run client
```

## Shell

```
glon> /list
KIND          NAME            SIZE     ID
typescript    store.ts        3933b    typescript:store.ts
typescript    proto.ts        4959b    typescript:proto.ts
proto         glon.proto      1359b    proto:glon.proto
...
11 objects

glon> /cat proto:glon.proto
syntax = "proto3";
package glon;
message GlonObject {
  ...
}

glon> /dump proto:glon.proto
1469 bytes of raw protobuf:
0000  0a 10 70 72 6f 74 6f 3a 67 6c 6f 6e 2e 70 72 6f   ..proto:glon.pro
0010  74 6f 12 05 70 72 6f 74 6f 1a 0a 67 6c 6f 6e 2e   to..proto..glon.
...

glon> /disk
path:     ~/.glon
objects:  9 .pb files
size:     29670 bytes (raw protobuf)
format:   protobuf wire format (binary)

glon> /info
objects:  11
store:    rivet actor + sqlite
format:   protobuf (glon.Object)

glon> /create note my-first-note
created note:my-first-note
```

### Commands

| Command | Description |
|---|---|
| `/list [kind]` | List all objects, optionally by kind |
| `/get <id>` | Inspect an object |
| `/search <query>` | Search by name |
| `/create <kind> <name>` | Create an object |
| `/delete <id>` | Delete an object |
| `/cat <id>` | Read content from disk (decoded protobuf) |
| `/dump <id>` | Hex dump of raw protobuf bytes |
| `/disk` | Disk storage stats |
| `/info` | System stats |
| `/kinds` | List object kinds |
| `/proto` | Show the proto schema |

## Project Structure

```
glon/
  proto/glon.proto         the primitive
  src/
    proto.ts               load .proto, encode/decode helpers
    disk.ts                read/write raw .pb to ~/.glon/
    actors/
      object.ts            object actor (one per entity)
      store.ts             store coordinator (SQLite index)
    index.ts               actor registry, start server
    bootstrap.ts           seed source files as objects
    client.ts              CLI shell
```

## Design

**One type.** No inheritance, no subtypes. The `kind` field and `meta` map
handle all variation.

**Binary on disk.** The `.pb` file IS the object. Decode with standard protoc:
```
protoc --decode=glon.GlonObject proto/glon.proto < ~/.glon/objects/proto_glon.proto.pb
```

**Actors are the runtime.** Each object is a durable actor. The actor model
provides isolation, persistence, communication, and lifecycle.

**Self-describing.** Every source file that builds Glon is an object inside Glon.

**Protobuf is the only format.** Storage, IPC, schema -- all protobuf.

## Status

See [WHITEROOM.md](WHITEROOM.md) for the full specification, including what
exists and what's planned.

## License

MIT
