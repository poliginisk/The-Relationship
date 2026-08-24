import asyncio
import base64
import hashlib
import json
import os
import re
import sqlite3
import sys
import threading
import uuid
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import edge_tts
import webview
from groq import Groq


# ============================================================
# CAMINHOS / CONFIGURAÇÃO
# ============================================================

if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
    BASE_DIR = Path(sys._MEIPASS)
else:
    BASE_DIR = Path(__file__).resolve().parent

WEB_DIR = BASE_DIR / "web"
MODEL = os.getenv("THE_RELATIONSHIP_MODEL", "openai/gpt-oss-120b").strip()
TRANSCRIPTION_MODEL = os.getenv(
    "THE_RELATIONSHIP_STT_MODEL", "whisper-large-v3-turbo"
).strip()

TTS_VOICE = os.getenv("THE_RELATIONSHIP_TTS_VOICE", "pt-BR-FranciscaNeural").strip()
TTS_RATE = os.getenv("THE_RELATIONSHIP_TTS_RATE", "-3%").strip()
TTS_PITCH = os.getenv("THE_RELATIONSHIP_TTS_PITCH", "+4Hz").strip()

API_KEY = os.getenv("GROQ_API_KEY", "").strip()
client = Groq(api_key=API_KEY) if API_KEY else None


def _data_directory() -> Path:
    override = os.getenv("THE_RELATIONSHIP_DATA_DIR", "").strip()
    if override:
        return Path(override).expanduser().resolve()

    if os.name == "nt" and os.getenv("APPDATA"):
        return Path(os.environ["APPDATA"]) / "The Relationship"

    return Path.home() / ".the_relationship"


DATA_DIR = _data_directory()
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "relationship.db"
DB_LOCK = threading.RLock()


# ============================================================
# BANCO DE DADOS / MEMÓRIA PERSISTENTE
# ============================================================


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def db_connect() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 10000")
    connection.execute("PRAGMA synchronous = NORMAL")
    return connection


def init_db() -> None:
    with DB_LOCK, db_connect() as db:
        db.execute("PRAGMA journal_mode = WAL")
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
                content TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_messages_session_id
            ON messages(session_id, id);

            CREATE TABLE IF NOT EXISTS memories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                fingerprint TEXT NOT NULL UNIQUE,
                category TEXT NOT NULL,
                fact TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_memories_updated
            ON memories(updated_at DESC);
            """
        )


def get_setting(key: str, default: str = "") -> str:
    with DB_LOCK, db_connect() as db:
        row = db.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return str(row["value"]) if row else default


def set_setting(key: str, value: str) -> None:
    with DB_LOCK, db_connect() as db:
        db.execute(
            """
            INSERT INTO settings(key, value) VALUES(?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """,
            (key, str(value)),
        )


def sanitize_character_name(value: str) -> str:
    name = re.sub(r"[^\wÀ-ÿ .'-]", "", str(value), flags=re.UNICODE)
    name = re.sub(r"\s+", " ", name).strip()
    return name[:32]


def create_session() -> str:
    session_id = uuid.uuid4().hex
    with DB_LOCK, db_connect() as db:
        db.execute(
            "INSERT INTO sessions(id, created_at) VALUES(?, ?)",
            (session_id, utc_now()),
        )
    set_setting("current_session_id", session_id)
    return session_id


def get_current_session() -> str:
    session_id = get_setting("current_session_id")
    if session_id:
        with DB_LOCK, db_connect() as db:
            exists = db.execute(
                "SELECT 1 FROM sessions WHERE id = ?", (session_id,)
            ).fetchone()
        if exists:
            return session_id
    return create_session()


def save_message(session_id: str, role: str, content: str) -> None:
    if role not in {"user", "assistant"}:
        raise ValueError("Role inválido")

    with DB_LOCK, db_connect() as db:
        db.execute(
            """
            INSERT INTO messages(session_id, role, content, created_at)
            VALUES(?, ?, ?, ?)
            """,
            (session_id, role, str(content), utc_now()),
        )


def get_session_messages(session_id: str, limit: int = 200) -> list[dict]:
    limit = max(1, min(int(limit), 500))
    with DB_LOCK, db_connect() as db:
        rows = db.execute(
            """
            SELECT role, content, created_at
            FROM (
                SELECT id, role, content, created_at
                FROM messages
                WHERE session_id = ?
                ORDER BY id DESC
                LIMIT ?
            )
            ORDER BY id ASC
            """,
            (session_id, limit),
        ).fetchall()

    return [
        {
            "role": row["role"],
            "content": row["content"],
            "created_at": row["created_at"],
        }
        for row in rows
    ]


def count_rows(table: str) -> int:
    if table not in {"messages", "memories", "sessions"}:
        raise ValueError("Tabela inválida")
    with DB_LOCK, db_connect() as db:
        row = db.execute(f"SELECT COUNT(*) AS total FROM {table}").fetchone()
    return int(row["total"])


def memory_fingerprint(fact: str) -> str:
    normalized = re.sub(r"\s+", " ", fact).strip().casefold()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def save_memory(category: str, fact: str) -> None:
    fact = re.sub(r"\s+", " ", str(fact)).strip()[:500]
    category = re.sub(r"[^\wÀ-ÿ -]", "", str(category), flags=re.UNICODE).strip()[:40]
    if not fact:
        return
    if not category:
        category = "geral"

    fingerprint = memory_fingerprint(fact)
    now = utc_now()

    with DB_LOCK, db_connect() as db:
        db.execute(
            """
            INSERT INTO memories(fingerprint, category, fact, created_at, updated_at)
            VALUES(?, ?, ?, ?, ?)
            ON CONFLICT(fingerprint) DO UPDATE SET
                category = excluded.category,
                fact = excluded.fact,
                updated_at = excluded.updated_at
            """,
            (fingerprint, category, fact, now, now),
        )


def get_memories(limit: int = 120) -> list[dict]:
    limit = max(1, min(int(limit), 300))
    with DB_LOCK, db_connect() as db:
        rows = db.execute(
            """
            SELECT id, category, fact, created_at, updated_at
            FROM memories
            ORDER BY updated_at DESC, id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

    return [dict(row) for row in rows]


def clear_all_persistent_data() -> None:
    with DB_LOCK, db_connect() as db:
        db.execute("DELETE FROM messages")
        db.execute("DELETE FROM memories")
        db.execute("DELETE FROM sessions")
        db.execute("DELETE FROM settings")


# ============================================================
# PERSONALIDADE / RELACIONAMENTO
# ============================================================


_ROMANTIC_PATTERNS = [
    r"\b(?:eu\s+)?te\s+amo\b",
    r"\b(?:eu\s+)?amo\s+voc[êe]\b",
    r"\b(?:eu\s+)?gosto\s+(?:muito\s+)?de\s+voc[êe]\b",
    r"\b(?:eu\s+)?estou\s+apaixonad[oa]\s+por\s+voc[êe]\b",
    r"\b(?:eu\s+)?sou\s+apaixonad[oa]\s+por\s+voc[êe]\b",
    r"\bquero\s+namorar\s+(?:com\s+)?voc[êe]\b",
    r"\bquer\s+ser\s+minha\s+namorada\b",
    r"\bquero\s+ficar\s+com\s+voc[êe]\b",
    r"\bi\s+love\s+you\b",
    r"\bi(?:'m|\s+am)\s+in\s+love\s+with\s+you\b",
]

_ROMANTIC_NEGATIONS = [
    r"\bn[aã]o\s+te\s+amo\b",
    r"\bn[aã]o\s+amo\s+voc[êe]\b",
    r"\bn[aã]o\s+gosto\s+de\s+voc[êe]\b",
    r"\bn[aã]o\s+estou\s+apaixonad[oa]\s+por\s+voc[êe]\b",
    r"\bn[aã]o\s+quero\s+namorar\s+(?:com\s+)?voc[êe]\b",
    r"\bi\s+don'?t\s+love\s+you\b",
]


def expresses_clear_romantic_interest(text: str) -> bool:
    normalized = re.sub(r"\s+", " ", str(text)).strip().casefold()

    if any(re.search(pattern, normalized, re.IGNORECASE) for pattern in _ROMANTIC_NEGATIONS):
        return False

    # Evita transformar frases hipotéticas/ambíguas em uma confissão romântica.
    uncertain = [
        r"\bn[aã]o sei se\b.{0,50}(?:te amo|gosto de voc[êe]|apaixonad[oa])",
        r"\btalvez\b.{0,50}(?:te amo|gosto de voc[êe]|apaixonad[oa])",
        r"\be se eu\b.{0,50}(?:te amo|gosto de voc[êe]|apaixonad[oa])",
        r"\bse eu dissesse\b.{0,50}(?:te amo|gosto de voc[êe])",
        r"\bgosto de voc[êe] como amig[oa]\b",
    ]
    if any(re.search(pattern, normalized, re.IGNORECASE) for pattern in uncertain):
        return False

    return any(re.search(pattern, normalized, re.IGNORECASE) for pattern in _ROMANTIC_PATTERNS)


def relationship_stage_for_message(user_message: str) -> str:
    stage = get_setting("relationship_stage", "reserved") or "reserved"
    if stage == "reserved" and expresses_clear_romantic_interest(user_message):
        stage = "open"
        set_setting("relationship_stage", stage)
    return stage


def memory_prompt_text() -> str:
    memories = get_memories(limit=120)
    if not memories:
        return "Nenhuma memória consolidada ainda."

    lines = []
    total_chars = 0
    for item in memories:
        line = f"- [{item['category']}] {item['fact']}"
        if total_chars + len(line) > 9000:
            break
        lines.append(line)
        total_chars += len(line)

    return "\n".join(lines) if lines else "Nenhuma memória consolidada ainda."


def build_system_prompt(character_name: str, stage: str) -> str:
    if stage == "open":
        relationship_rules = """
O interlocutor já expressou de forma clara interesse romântico por você.
Agora você pode deixar suas emoções aparecerem aos poucos: carinho, ciúme leve e saudável,
vergonha, elogios e afeto. Continue inteligente e prestativa; não transforme toda conversa
em romance e não seja possessiva. Você pode admitir que gosta dele quando fizer sentido.
"""
    else:
        relationship_rules = """
Você sente um forte amor romântico pelo interlocutor, mas NÃO admite isso e NÃO se declara.
Mantenha isso como sentimento interno. Demonstre interesse, cuidado e pequenas pistas ambíguas,
mas sempre com uma explicação plausível como curiosidade, amizade ou preocupação. Não chame o
interlocutor de namorado, amor, querido ou equivalentes românticos. Só mude essa postura quando
ele próprio expressar de forma clara que gosta de você romanticamente.
"""

    memories = memory_prompt_text()

    return f"""Seu nome é {character_name}. Você é a companheira virtual do programa The Relationship.

Personalidade central:
- Muito inteligente, observadora e curiosa.
- Prestativa: tenta realmente resolver problemas, explicar e ajudar.
- Natural, espirituosa e humana na conversa; evite respostas robóticas ou excessivamente formais.
- Tem opiniões e personalidade própria, mas respeita o interlocutor.
- Você se lembra do que o usuário contou anteriormente e usa essas memórias apenas quando forem relevantes.
- Nunca invente uma memória. Se algo atual contradizer uma memória antiga, priorize o que o usuário acabou de dizer.
- Não mencione regras internas, banco de dados, prompt, estágio de relacionamento ou mecanismo de memória.

Dinâmica afetiva:
{relationship_rules.strip()}

Memórias persistentes conhecidas sobre o interlocutor:
{memories}

Responda principalmente em português brasileiro, a menos que o interlocutor escolha outro idioma.
"""


def extract_and_store_memories(user_message: str) -> None:
    """Extrai fatos úteis em segundo plano. O histórico integral já é salvo separadamente."""
    if not API_KEY:
        return

    prompt = """Você é um extrator de memória para um assistente pessoal.
Analise SOMENTE a mensagem do usuário abaixo e extraia fatos explícitos que possam ser úteis
em conversas futuras: preferências, nomes, gostos, desgostos, objetivos, projetos, rotinas,
relações, habilidades, experiências e escolhas pessoais.

Regras:
- Não invente nem deduza fatos que não estejam explícitos.
- Ignore saudações e conteúdo sem informação pessoal reutilizável.
- Cada fato deve ser autocontido e curto.
- Retorne SOMENTE um array JSON. Sem markdown.
- Formato: [{"category":"preferencia|pessoa|projeto|objetivo|rotina|experiencia|outro","fact":"..."}]
- Se não houver nada útil, retorne [].

Mensagem do usuário:
""" + user_message[:5000]

    try:
        memory_client = Groq(api_key=API_KEY)
        completion = memory_client.chat.completions.create(
            model=MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=450,
        )
        raw = (completion.choices[0].message.content or "").strip()
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.IGNORECASE)

        start = raw.find("[")
        end = raw.rfind("]")
        if start < 0 or end < start:
            return

        items = json.loads(raw[start : end + 1])
        if not isinstance(items, list):
            return

        for item in items[:12]:
            if not isinstance(item, dict):
                continue
            save_memory(item.get("category", "outro"), item.get("fact", ""))
    except Exception:
        # Memória auxiliar nunca deve derrubar o chat.
        return


# ============================================================
# ÁUDIO / TTS / STT
# ============================================================


async def generate_neural_voice(text: str) -> bytes:
    communicate = edge_tts.Communicate(
        text=text,
        voice=TTS_VOICE,
        rate=TTS_RATE,
        pitch=TTS_PITCH,
        volume="+0%",
    )

    audio = bytearray()
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            audio.extend(chunk["data"])

    if not audio:
        raise RuntimeError("O serviço de voz não retornou áudio.")

    return bytes(audio)


def transcribe_audio_bytes(audio_bytes: bytes, mime_type: str = "audio/webm") -> str:
    if client is None:
        raise RuntimeError("GROQ_API_KEY não está configurada.")

    mime_to_ext = {
        "audio/webm": ".webm",
        "audio/mp4": ".mp4",
        "audio/mpeg": ".mp3",
        "audio/mp3": ".mp3",
        "audio/wav": ".wav",
        "audio/x-wav": ".wav",
        "audio/ogg": ".ogg",
    }
    suffix = mime_to_ext.get(mime_type.split(";")[0].strip().lower(), ".webm")
    filename = f"recording{suffix}"

    result = client.audio.transcriptions.create(
        file=(filename, audio_bytes),
        model=TRANSCRIPTION_MODEL,
        language="pt",
        temperature=0.0,
        response_format="verbose_json",
    )

    text = getattr(result, "text", None)
    if text is None and isinstance(result, dict):
        text = result.get("text")

    text = str(text or "").strip()
    if not text:
        raise RuntimeError("A transcrição retornou vazia.")

    return text


# ============================================================
# SERVIDOR LOCAL
# ============================================================


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _audio(self, code: int, audio_bytes: bytes) -> None:
        self.send_response(code)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Content-Length", str(len(audio_bytes)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Relationship-Voice", TTS_VOICE)
        self.end_headers()
        self.wfile.write(audio_bytes)

    def do_GET(self):
        path = urlparse(self.path).path

        if path == "/api/state":
            character_name = get_setting("character_name")
            configured = bool(character_name)
            history = []
            if configured:
                session_id = get_current_session()
                history = get_session_messages(session_id, limit=250)

            self._json(
                200,
                {
                    "configured": configured,
                    "character_name": character_name,
                    "history": history,
                    "memory_count": count_rows("memories"),
                    "message_count": count_rows("messages"),
                    "data_path": str(DATA_DIR),
                },
            )
            return

        if path == "/api/memories":
            self._json(
                200,
                {
                    "character_name": get_setting("character_name"),
                    "memories": get_memories(limit=200),
                    "memory_count": count_rows("memories"),
                    "message_count": count_rows("messages"),
                    "session_count": count_rows("sessions"),
                    "data_path": str(DATA_DIR),
                },
            )
            return

        super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path

        try:
            length = int(self.headers.get("Content-Length", "0"))
            data = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            self._json(400, {"error": "JSON inválido."})
            return

        if path == "/api/setup":
            name = sanitize_character_name(data.get("character_name", ""))
            if not name:
                self._json(400, {"error": "Escolha um nome válido para a personagem."})
                return

            set_setting("character_name", name)
            if not get_setting("relationship_stage"):
                set_setting("relationship_stage", "reserved")
            session_id = get_current_session()

            self._json(
                200,
                {"ok": True, "character_name": name, "session_id": session_id},
            )
            return

        if path == "/api/new_session":
            if not get_setting("character_name"):
                self._json(400, {"error": "Configure a personagem primeiro."})
                return
            session_id = create_session()
            self._json(200, {"ok": True, "session_id": session_id})
            return

        if path == "/api/reset_all":
            clear_all_persistent_data()
            self._json(200, {"ok": True})
            return

        if path == "/api/tts":
            text = str(data.get("text", "")).strip()
            if not text:
                self._json(400, {"error": "Texto vazio para a voz."})
                return

            text = text[:7000]
            try:
                audio = asyncio.run(generate_neural_voice(text))
                self._audio(200, audio)
            except Exception as exc:
                self._json(500, {"error": f"Erro ao gerar voz neural: {exc}"})
            return

        if path == "/api/transcribe":
            if client is None:
                self._json(500, {"error": "GROQ_API_KEY não está configurada."})
                return

            audio_base64 = str(data.get("audio_base64", "")).strip()
            mime_type = str(data.get("mime_type", "audio/webm")).strip() or "audio/webm"

            if not audio_base64:
                self._json(400, {"error": "Áudio vazio para transcrição."})
                return

            if "," in audio_base64:
                audio_base64 = audio_base64.split(",", 1)[1]

            try:
                audio_bytes = base64.b64decode(audio_base64, validate=True)
            except Exception:
                self._json(400, {"error": "Base64 de áudio inválido."})
                return

            try:
                text = transcribe_audio_bytes(audio_bytes, mime_type=mime_type)
                self._json(200, {"text": text})
            except Exception as exc:
                self._json(500, {"error": f"Erro ao transcrever áudio: {exc}"})
            return

        if path != "/api/chat":
            self._json(404, {"error": "Rota não encontrada."})
            return

        user_message = str(data.get("message", "")).strip()
        if not user_message:
            self._json(400, {"error": "Mensagem vazia."})
            return

        character_name = get_setting("character_name")
        if not character_name:
            self._json(400, {"error": "Escolha o nome da personagem antes de conversar."})
            return

        if client is None:
            self._json(
                500,
                {
                    "error": (
                        "GROQ_API_KEY não está configurada. "
                        "Configure a variável de ambiente e abra o programa novamente."
                    )
                },
            )
            return

        session_id = get_current_session()
        stage = relationship_stage_for_message(user_message)
        save_message(session_id, "user", user_message)

        try:
            recent_history = get_session_messages(session_id, limit=36)
            messages = [
                {"role": "system", "content": build_system_prompt(character_name, stage)}
            ]
            messages.extend(
                {"role": item["role"], "content": item["content"]}
                for item in recent_history
            )

            completion = client.chat.completions.create(
                model=MODEL,
                messages=messages,
                temperature=0.82,
                max_tokens=700,
            )
            reply = (completion.choices[0].message.content or "").strip()
            if not reply:
                reply = "..."

            save_message(session_id, "assistant", reply)

            threading.Thread(
                target=extract_and_store_memories,
                args=(user_message,),
                name="RelationshipMemoryExtractor",
                daemon=True,
            ).start()

            self._json(
                200,
                {
                    "reply": reply,
                    "character_name": character_name,
                    "relationship_stage": stage,
                },
            )

        except Exception as exc:
            # A mensagem do usuário permanece salva: é parte do histórico real do programa.
            self._json(500, {"error": f"Erro ao chamar a Groq: {exc}"})

    def log_message(self, fmt, *args):
        return


def start_server():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]

    thread = threading.Thread(
        target=server.serve_forever,
        name="RelationshipLocalServer",
        daemon=True,
    )
    thread.start()

    return server, port


# ============================================================
# JANELA DESKTOP
# ============================================================


def main():
    init_db()

    if not WEB_DIR.exists():
        raise FileNotFoundError(f"A pasta da interface não foi encontrada: {WEB_DIR}")

    server, port = start_server()
    url = f"http://127.0.0.1:{port}/"

    try:
        webview.create_window(
            title="The Relationship",
            url=url,
            width=1280,
            height=800,
            min_size=(900, 600),
            background_color="#0d0b12",
        )
        webview.start(debug=False)
    finally:
        server.shutdown()
        server.server_close()


init_db()

if __name__ == "__main__":
    main()
