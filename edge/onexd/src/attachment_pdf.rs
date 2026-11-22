//! Text-only PDF attachment extraction in a separate onexd subprocess.

use std::io::{self, Read, Write};

use anyhow::{Result, ensure};
use objc2::msg_send;
use objc2::rc::{Allocated, Retained, autoreleasepool};
use objc2::runtime::{AnyClass, AnyObject, Bool};
use objc2_foundation::{NSData, NSString};

const MAX_PDF_BYTES: usize = 16 * 1024 * 1024;
const MAX_PAGES: usize = 64;
const MAX_TEXT_BYTES: usize = 256 * 1024;

#[link(name = "PDFKit", kind = "framework")]
unsafe extern "C" {
    #[link_name = "OBJC_CLASS_$_PDFDocument"]
    static PDF_DOCUMENT: AnyClass;
}

pub fn stdio() -> Result<()> {
    let mut pdf = Vec::new();
    io::stdin().lock().take(MAX_PDF_BYTES as u64 + 1).read_to_end(&mut pdf)?;
    let text = extract(&pdf)?;
    io::stdout().lock().write_all(text.as_bytes())?;
    Ok(())
}

fn extract(pdf: &[u8]) -> Result<String> {
    ensure!(pdf.len() <= MAX_PDF_BYTES, "pdf_input_too_large");
    ensure!(has_pdf_structure(pdf), "invalid_pdf");
    autoreleasepool(|_| objc2::exception::catch(|| pdfkit_text(pdf)).map_err(|_| anyhow::anyhow!("invalid_pdf"))?)
}

fn has_pdf_structure(pdf: &[u8]) -> bool {
    if !pdf.starts_with(b"%PDF-") {
        return false;
    }
    let Some(body) = pdf.trim_ascii_end().strip_suffix(b"%%EOF") else { return false };
    let Some(marker) = body.windows(9).rposition(|window| window == b"startxref") else { return false };
    let Ok(offset) = std::str::from_utf8(body[marker + 9..].trim_ascii()) else { return false };
    let Ok(offset) = offset.parse::<usize>() else { return false };
    let Some(table) = body.get(offset..marker) else { return false };
    let mut fields = table.split(|byte| byte.is_ascii_whitespace()).filter(|field| !field.is_empty());
    let Some(first) = fields.next() else { return false };
    first == b"xref"
        || (first.iter().all(u8::is_ascii_digit)
            && fields.next().is_some_and(|field| field.iter().all(u8::is_ascii_digit))
            && fields.next() == Some(b"obj"))
}

fn pdfkit_text(pdf: &[u8]) -> Result<String> {
    // PDFKit classes and methods below are public Objective-C APIs. NSData retains a copy of
    // the bounded input. Integer indices and page counts are NSUInteger on both Mac targets.
    let data = NSData::with_bytes(pdf);
    let document: Option<Retained<AnyObject>> = unsafe {
        let instance: Allocated<AnyObject> = msg_send![&PDF_DOCUMENT, alloc];
        msg_send![instance, initWithData: &*data]
    };
    let document = document.ok_or_else(|| anyhow::anyhow!("invalid_pdf"))?;
    let encrypted: Bool = unsafe { msg_send![&document, isEncrypted] };
    ensure!(!encrypted.as_bool(), "encrypted_pdf");
    let pages: usize = unsafe { msg_send![&document, pageCount] };
    ensure!(pages > 0, "invalid_pdf");
    ensure!(pages <= MAX_PAGES, "pdf_too_many_pages");
    let mut output = String::new();
    for index in 0..pages {
        autoreleasepool(|_| append_page(&document, index, &mut output))?;
    }
    Ok(output)
}

fn append_page(document: &AnyObject, index: usize, output: &mut String) -> Result<()> {
    let page: Option<Retained<AnyObject>> = unsafe { msg_send![document, pageAtIndex: index] };
    let page = page.ok_or_else(|| anyhow::anyhow!("invalid_pdf"))?;
    let text: Option<Retained<NSString>> = unsafe { msg_send![&page, string] };
    let text = text.ok_or_else(|| anyhow::anyhow!("pdf_no_text"))?;
    ensure!(text.len() <= MAX_TEXT_BYTES, "pdf_text_too_large");
    let text = text.to_string();
    let previous = output.len();
    if previous > 0 {
        output.push('\n');
    }
    let start = output.len();
    for line in text.split(['\r', '\n', '\u{c}', '\u{2028}', '\u{2029}']) {
        let line: String = line.trim().chars().filter(|ch| !ch.is_control() || *ch == '\t').collect();
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        ensure!(output.len() + line.len() < MAX_TEXT_BYTES, "pdf_text_too_large");
        output.push_str(line);
        output.push('\n');
    }
    ensure!(output.len() > start, "pdf_no_text");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(pages: usize, content: &str) -> Vec<u8> {
        let children = (0..pages).map(|index| format!("{} 0 R", index + 5)).collect::<Vec<_>>().join(" ");
        let mut objects = vec![
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            format!("<< /Type /Pages /Count {pages} /Kids [{children}] >>"),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
            format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()),
        ];
        let page = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>";
        objects.extend((0..pages).map(|_| page.to_string()));
        let mut pdf = b"%PDF-1.4\n".to_vec();
        let mut xref = "0000000000 65535 f \n".to_string();
        for (index, value) in objects.iter().enumerate() {
            xref.push_str(&format!("{:010} 00000 n \n", pdf.len()));
            pdf.extend_from_slice(format!("{} 0 obj\n{value}\nendobj\n", index + 1).as_bytes());
        }
        let offset = pdf.len();
        let size = objects.len() + 1;
        pdf.extend_from_slice(
            format!("xref\n0 {size}\n{xref}trailer\n<< /Size {size} /Root 1 0 R >>\nstartxref\n{offset}\n%%EOF\n")
                .as_bytes(),
        );
        pdf
    }

    #[test]
    fn extracts_generated_pdf_without_a_file_path() {
        let pdf = fixture(2, "BT /F1 18 Tf 30 210 Td (OneX PDF sample) Tj ET");
        assert_eq!(extract(&pdf).unwrap(), "OneX PDF sample\n\nOneX PDF sample\n");
    }

    #[test]
    fn rejects_nontext_malformed_and_excessive_pages() {
        assert_eq!(extract(b"not PDF").unwrap_err().to_string(), "invalid_pdf");
        let mut truncated = fixture(1, "");
        truncated.truncate(truncated.len() - 10);
        assert_eq!(extract(&truncated).unwrap_err().to_string(), "invalid_pdf");
        assert_eq!(extract(&fixture(1, "")).unwrap_err().to_string(), "pdf_no_text");
        assert_eq!(extract(&fixture(MAX_PAGES + 1, "")).unwrap_err().to_string(), "pdf_too_many_pages");
        assert_eq!(extract(&vec![0; MAX_PDF_BYTES + 1]).unwrap_err().to_string(), "pdf_input_too_large");
    }
}
