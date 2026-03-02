from fastapi import FastAPI, UploadFile, File, HTTPException
from paddleocr import PaddleOCR
import tempfile
import os

app = FastAPI(title="OCR Service")

ocr = PaddleOCR(use_angle_cls=True, lang="en", show_log=False)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/ocr")
async def extract_text(file: UploadFile = File(...)):
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="File must be an image")

    with tempfile.NamedTemporaryFile(delete=False, suffix=os.path.splitext(file.filename or "img")[1]) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name

    try:
        result = ocr.ocr(tmp_path, cls=True)
    finally:
        os.unlink(tmp_path)

    lines = []
    if result and result[0]:
        for line in result[0]:
            text = line[1][0]
            confidence = line[1][1]
            bbox = line[0]
            lines.append({
                "text": text,
                "confidence": round(confidence, 4),
                "bbox": bbox,
            })

    full_text = "\n".join(l["text"] for l in lines)

    return {
        "text": full_text,
        "lines": lines,
        "line_count": len(lines),
    }
