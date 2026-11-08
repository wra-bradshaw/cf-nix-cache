//! Streaming structural validation of a NAR (verification level 3).
//!
//! A NAR is a sequence of length-prefixed strings, each padded with zeros to
//! a multiple of 8 bytes. File contents are one more such string, counted
//! rather than buffered. The grammar is tracked as an explicit stack of what
//! the next string must be, so bytes can be pushed in any split.

use std::fmt;

const MAX_TOKEN_BYTES: u64 = 4096;
const MAX_NAME_BYTES: u64 = 255;
const MAX_DEPTH: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidNar(pub String);

impl fmt::Display for InvalidNar {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for InvalidNar {}

fn fail<T>(message: impl Into<String>) -> Result<T, InvalidNar> {
    Err(InvalidNar(message.into()))
}

/// What the next string in the archive must be.
#[derive(Debug)]
enum Expect {
    Literal(&'static str),
    /// A node's type, after `(` `type`.
    Type,
    /// After a regular file's type: `executable` or `contents`.
    Regular,
    /// The empty string after `executable`.
    Empty,
    /// A file's contents, which are skipped.
    Contents,
    /// A symlink's target, which must not be empty.
    Target,
    /// Inside a directory: `entry` or `)`. Holds the last entry's name.
    Directory {
        previous: Option<Vec<u8>>,
    },
    /// A directory entry's name.
    Name,
}

impl Expect {
    fn max_len(&self) -> Option<u64> {
        match self {
            Expect::Contents => None,
            Expect::Name => Some(MAX_NAME_BYTES),
            Expect::Empty => Some(0),
            _ => Some(MAX_TOKEN_BYTES),
        }
    }
}

#[derive(Debug)]
enum Phase {
    /// Reading a string's 8-byte length.
    Length { bytes: [u8; 8], have: usize },
    /// Reading a string's body: buffered, or skipped when `token` is `None`.
    Body {
        len: u64,
        remaining: u64,
        token: Option<Vec<u8>>,
    },
    /// Reading a string's zero padding.
    Padding { remaining: usize, token: Vec<u8> },
}

pub struct NarValidator {
    phase: Phase,
    stack: Vec<Expect>,
    directories: usize,
}

impl Default for NarValidator {
    fn default() -> Self {
        Self::new()
    }
}

impl NarValidator {
    pub fn new() -> Self {
        Self {
            phase: Phase::Length {
                bytes: [0; 8],
                have: 0,
            },
            // The top of the stack, the last element, is what comes next.
            stack: vec![
                Expect::Type,
                Expect::Literal("type"),
                Expect::Literal("("),
                Expect::Literal("nix-archive-1"),
            ],
            directories: 0,
        }
    }

    pub fn push(&mut self, mut input: &[u8]) -> Result<(), InvalidNar> {
        while !input.is_empty() {
            if self.stack.is_empty() {
                return fail("trailing bytes after NAR archive");
            }
            match &mut self.phase {
                Phase::Length { bytes, have } => {
                    let take = (8 - *have).min(input.len());
                    bytes[*have..*have + take].copy_from_slice(&input[..take]);
                    *have += take;
                    input = &input[take..];
                    if *have == 8 {
                        let len = u64::from_le_bytes(*bytes);
                        self.start_body(len)?;
                    }
                }
                Phase::Body {
                    len,
                    remaining,
                    token,
                } => {
                    let take = (*remaining).min(input.len() as u64) as usize;
                    if let Some(token) = token {
                        token.extend_from_slice(&input[..take]);
                    }
                    *remaining -= take as u64;
                    input = &input[take..];
                    if *remaining == 0 {
                        let len = *len;
                        let token = token.take().unwrap_or_default();
                        self.start_padding(len, token)?;
                    }
                }
                Phase::Padding { remaining, .. } => {
                    let take = (*remaining).min(input.len());
                    if input[..take].iter().any(|&byte| byte != 0) {
                        return fail("NAR padding is not zero");
                    }
                    *remaining -= take;
                    input = &input[take..];
                    if *remaining == 0 {
                        self.end_string()?;
                    }
                }
            }
        }
        Ok(())
    }

    pub fn finish(&self) -> Result<(), InvalidNar> {
        if !self.stack.is_empty() {
            return fail("NAR archive is truncated");
        }
        Ok(())
    }

    fn start_body(&mut self, len: u64) -> Result<(), InvalidNar> {
        let expect = self.stack.last().expect("checked by push");
        let token = match expect.max_len() {
            None => None,
            Some(max) if len > max => return fail("NAR string is too long"),
            Some(_) => Some(Vec::with_capacity(len as usize)),
        };
        if len == 0 {
            return self.start_padding(0, token.unwrap_or_default());
        }
        self.phase = Phase::Body {
            len,
            remaining: len,
            token,
        };
        Ok(())
    }

    fn start_padding(&mut self, len: u64, token: Vec<u8>) -> Result<(), InvalidNar> {
        let remaining = ((8 - len % 8) % 8) as usize;
        self.phase = Phase::Padding { remaining, token };
        if remaining == 0 {
            self.end_string()?;
        }
        Ok(())
    }

    fn end_string(&mut self) -> Result<(), InvalidNar> {
        let phase = std::mem::replace(
            &mut self.phase,
            Phase::Length {
                bytes: [0; 8],
                have: 0,
            },
        );
        let Phase::Padding { token, .. } = phase else {
            unreachable!("strings end after their padding");
        };
        self.accept(token)
    }

    fn accept(&mut self, token: Vec<u8>) -> Result<(), InvalidNar> {
        use Expect::*;
        match self.stack.pop().expect("checked by push") {
            Literal(expected) => {
                if token != expected.as_bytes() {
                    return fail(format!("expected NAR token \"{expected}\""));
                }
            }
            Type => {
                // The root node is at depth 0, so this allows the root plus
                // MAX_DEPTH nested directories (257 directory nodes total).
                if self.directories > MAX_DEPTH {
                    return fail("NAR is nested too deeply");
                }
                match token.as_slice() {
                    b"regular" => self.stack.push(Regular),
                    b"symlink" => {
                        self.stack.extend([Literal(")"), Target, Literal("target")]);
                    }
                    b"directory" => {
                        self.directories += 1;
                        self.stack.push(Directory { previous: None });
                    }
                    other => {
                        return fail(format!(
                            "unknown NAR node type \"{}\"",
                            String::from_utf8_lossy(other)
                        ))
                    }
                }
            }
            Regular => match token.as_slice() {
                b"executable" => {
                    self.stack
                        .extend([Literal(")"), Contents, Literal("contents"), Empty]);
                }
                b"contents" => self.stack.extend([Literal(")"), Contents]),
                _ => return fail("expected NAR file contents"),
            },
            Empty | Contents => {}
            Target => {
                if token.is_empty() {
                    return fail("empty symlink target");
                }
                if token.contains(&0) {
                    return fail("invalid symlink target");
                }
            }
            Directory { previous } => match token.as_slice() {
                b")" => {
                    debug_assert!(
                        self.directories > 0,
                        "directory close without an open directory"
                    );
                    self.directories = self
                        .directories
                        .checked_sub(1)
                        .ok_or_else(|| InvalidNar("NAR directory depth underflow".into()))?;
                }
                b"entry" => self.stack.extend([
                    Directory { previous },
                    Literal(")"),
                    Type,
                    Literal("type"),
                    Literal("("),
                    Literal("node"),
                    Name,
                    Literal("name"),
                    Literal("("),
                ]),
                _ => return fail("expected NAR directory entry"),
            },
            Name => {
                if !valid_name(&token) {
                    return fail("invalid NAR entry name");
                }
                let Some(Directory { previous }) = self
                    .stack
                    .iter_mut()
                    .rev()
                    .find(|expect| matches!(expect, Directory { .. }))
                else {
                    unreachable!("names are only expected inside directories");
                };
                if previous.as_deref().is_some_and(|last| last >= &token[..]) {
                    return fail("NAR directory entries are not sorted");
                }
                *previous = Some(token);
            }
        }
        Ok(())
    }
}

fn valid_name(name: &[u8]) -> bool {
    !name.is_empty() && name != b"." && name != b".." && !name.contains(&0) && !name.contains(&b'/')
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) enum Field<'a> {
        S(&'a str),
        B(&'a [u8]),
    }

    pub(crate) fn nar(fields: &[Field]) -> Vec<u8> {
        let mut out = Vec::new();
        for field in fields {
            let bytes = match field {
                Field::S(text) => text.as_bytes(),
                Field::B(bytes) => bytes,
            };
            out.extend_from_slice(&(bytes.len() as u64).to_le_bytes());
            out.extend_from_slice(bytes);
            out.resize(out.len() + (8 - bytes.len() % 8) % 8, 0);
        }
        out
    }

    fn tokens(text: &str) -> Vec<Field<'_>> {
        text.split(' ')
            .map(|token| Field::S(if token == "''" { "" } else { token }))
            .collect()
    }

    fn tree() -> Vec<u8> {
        nar(&tokens(
            "nix-archive-1 ( type directory \
             entry ( name bin node ( type directory \
               entry ( name hello node ( type regular executable '' contents #!/bin/sh ) ) \
             ) ) \
             entry ( name link node ( type symlink target bin/hello ) ) \
             entry ( name share node ( type regular contents '' ) ) \
             )",
        ))
    }

    fn validate(bytes: &[u8], split: usize) -> Result<(), InvalidNar> {
        let mut validator = NarValidator::new();
        for part in bytes.chunks(split.max(1)) {
            validator.push(part)?;
        }
        validator.finish()
    }

    fn error(bytes: &[u8]) -> String {
        validate(bytes, bytes.len()).unwrap_err().0
    }

    #[test]
    fn accepts_every_node_type_in_any_split() {
        let tree = tree();
        for split in [1, 3, 8, 13, tree.len()] {
            validate(&tree, split).unwrap();
        }
        validate(
            &nar(&tokens("nix-archive-1 ( type regular contents hello )")),
            5,
        )
        .unwrap();
    }

    #[test]
    fn rejects_truncated_archives_and_trailing_bytes() {
        let tree = tree();
        assert!(error(&tree[..tree.len() - 8]).contains("truncated"));
        let mut trailing = tree.clone();
        trailing.extend_from_slice(&[0; 8]);
        assert!(error(&trailing).contains("trailing"));
    }

    #[test]
    fn rejects_unsorted_and_invalid_names() {
        let unsorted = nar(&tokens(
            "nix-archive-1 ( type directory \
             entry ( name b node ( type regular contents '' ) ) \
             entry ( name a node ( type regular contents '' ) ) )",
        ));
        assert!(error(&unsorted).contains("not sorted"));
        for name in ["", ".", "..", "a/b"] {
            let mut fields = tokens("nix-archive-1 ( type directory entry ( name");
            fields.push(Field::S(name));
            fields.extend(tokens("node ( type regular contents '' ) ) )"));
            assert!(error(&nar(&fields)).contains("invalid NAR entry name"));
        }
        let long = "x".repeat(256);
        let mut fields = tokens("nix-archive-1 ( type directory entry ( name");
        fields.push(Field::S(&long));
        fields.extend(tokens("node ( type regular contents '' ) ) )"));
        assert!(error(&nar(&fields)).contains("too long"));
    }

    #[test]
    fn rejects_bad_padding_unknown_tokens_and_deep_nesting() {
        let mut padded = nar(&tokens("nix-archive-1 ( type regular contents abc )"));
        let index = padded.iter().rposition(|&byte| byte == b'c').unwrap() + 1;
        padded[index] = 1;
        assert!(error(&padded).contains("padding"));
        assert!(
            error(&nar(&tokens("nix-archive-2 ( type regular contents '' )")))
                .contains("nix-archive-1")
        );
        assert!(
            error(&nar(&tokens("nix-archive-1 ( type fifo )"))).contains("unknown NAR node type")
        );
        assert!(
            error(&nar(&tokens("nix-archive-1 ( type symlink target '' )")))
                .contains("empty symlink")
        );
        assert!(error(&nar(&[
            Field::S("nix-archive-1"),
            Field::S("("),
            Field::S("type"),
            Field::S("symlink"),
            Field::S("target"),
            Field::B(b"a\0b"),
            Field::S(")"),
        ]))
        .contains("invalid symlink target"));
        assert!(error(&nar(&[
            Field::S("nix-archive-1"),
            Field::S("("),
            Field::S("type"),
            Field::S("regular"),
            Field::S("executable"),
            Field::S("x"),
        ]))
        .contains("too long"));

        // The root is at depth 0, so MAX_DEPTH nested directories are allowed.
        let deep = |levels: usize| {
            let mut text = String::from("nix-archive-1 ( type directory");
            for _ in 0..levels {
                text.push_str(" entry ( name d node ( type directory");
            }
            text.push_str(" )");
            for _ in 0..levels {
                text.push_str(" ) )");
            }
            nar(&tokens(&text))
        };
        validate(&deep(MAX_DEPTH), 4096).unwrap();
        assert!(error(&deep(MAX_DEPTH + 1)).contains("nested too deeply"));
    }

    #[test]
    fn skips_large_contents_without_buffering() {
        let contents = vec![7u8; 3 * 1024 * 1024 + 5];
        let mut fields = tokens("nix-archive-1 ( type regular contents");
        fields.push(Field::B(&contents));
        fields.push(Field::S(")"));
        validate(&nar(&fields), 64 * 1024).unwrap();
    }
}
