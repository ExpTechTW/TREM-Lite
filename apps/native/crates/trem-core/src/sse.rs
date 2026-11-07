//! The wire format of ExpTech's SSE streams (features/data/dataHttp.ts): blocks of
//! `event:` and `data:` lines, `:` comments, and the trem stream's compressed payloads.
//! Keeping a connection open is each app's own.

#[derive(Debug, Default, PartialEq)]
pub struct Frame {
    pub event: Option<String>,
    pub data: String,
    /// A `:` comment line — the server's `: ping <unix s>` heartbeat.
    pub comment: Option<String>,
}

/// One SSE block. `:` comments (the server's `: ping`) carry no data.
pub fn parse_frame(block: &str) -> Frame {
    let mut frame = Frame::default();
    let mut first = true;
    for line in block.split('\n') {
        if line.is_empty() {
            continue;
        }
        if let Some(comment) = line.strip_prefix(':') {
            frame.comment = Some(comment.trim().to_string());
            continue;
        }
        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (line, ""),
        };
        match field {
            "event" => frame.event = Some(value.to_string()),
            "data" => {
                if !first {
                    frame.data.push('\n');
                }
                frame.data.push_str(value);
                first = false;
            }
            _ => {}
        }
    }
    frame
}

/// Splits a byte stream into SSE frames, holding a partial one for the next chunk.
#[derive(Default)]
pub struct FrameReader {
    buffer: Vec<u8>,
}

impl FrameReader {
    pub fn push(&mut self, chunk: &[u8], out: &mut Vec<Frame>) {
        self.buffer.extend(chunk.iter().filter(|b| **b != b'\r'));
        let mut start = 0;
        while let Some(end) = self.buffer[start..]
            .windows(2)
            .position(|w| w == b"\n\n")
            .map(|p| p + start)
        {
            out.push(parse_frame(&String::from_utf8_lossy(
                &self.buffer[start..end],
            )));
            start = end + 2;
        }
        if start > 0 {
            self.buffer.drain(..start);
        }
    }
}

/// An SSE data field of the trem stream: base64 of gzip of the payload. A field that
/// is not comes back as is.
pub fn decode_payload(data: &str) -> String {
    use base64::Engine;
    use std::io::Read;
    let compact: String = data.chars().filter(|c| !c.is_whitespace()).collect();
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(compact) else {
        return data.to_string();
    };
    if bytes.len() < 2 || bytes[0] != 0x1f || bytes[1] != 0x8b {
        return data.to_string();
    }
    let mut out = String::new();
    match flate2::read::GzDecoder::new(&bytes[..]).read_to_string(&mut out) {
        Ok(_) => out,
        Err(_) => data.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_block_gives_event_data_and_comment() {
        let frame = parse_frame("event: trem.rts.v1\ndata: abc\ndata: def");
        assert_eq!(frame.event.as_deref(), Some("trem.rts.v1"));
        assert_eq!(frame.data, "abc\ndef");
        let ping = parse_frame(": ping 1790000000");
        assert_eq!(ping.comment.as_deref(), Some("ping 1790000000"));
        assert!(ping.data.is_empty());
    }

    #[test]
    fn the_reader_holds_a_partial_frame_and_drops_carriage_returns() {
        let mut reader = FrameReader::default();
        let mut out = Vec::new();
        reader.push(b"data: a\r\n\r\nda", &mut out);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].data, "a");
        out.clear();
        reader.push(b"ta: b\n\n", &mut out);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].data, "b");
    }

    #[test]
    fn a_field_with_no_space_after_the_colon_is_read_too() {
        assert_eq!(parse_frame("data:x").data, "x");
    }

    #[test]
    fn payloads_that_are_not_compressed_come_back_as_is() {
        assert_eq!(decode_payload("{\"a\":1}"), "{\"a\":1}");
        assert_eq!(decode_payload("aGVsbG8="), "aGVsbG8=");
    }
}
