from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
import os
import re
import secrets
import sqlite3

import httpx
from dotenv import load_dotenv

from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field


API_DIR = Path(__file__).resolve().parent.parent
load_dotenv(API_DIR / ".env")

from app.ai import router as ai_router

DB_PATH = API_DIR / "sukarisol.db"



def get_connection():
    connection = sqlite3.connect(DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def initialize_database():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)

    with get_connection() as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS farmers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                farmer_code TEXT UNIQUE NOT NULL,
                full_name TEXT NOT NULL,
                phone TEXT,
                county TEXT NOT NULL,
                sub_county TEXT,
                cooperative TEXT,
                created_at TEXT NOT NULL
            )
        """)
        db.execute("""
            CREATE INDEX IF NOT EXISTS idx_farmers_name
            ON farmers(full_name)
        """)
        db.execute("""
            CREATE INDEX IF NOT EXISTS idx_farmers_county
            ON farmers(county)
        """)


@asynccontextmanager
async def lifespan(app: FastAPI):
    initialize_database()
    yield


app = FastAPI(
    title="SukariSol API",
    description="Intelligence and interoperability for Kenya's sugar value chain.",
    version="0.2.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


app.include_router(ai_router)


class FarmerCreate(BaseModel):
    full_name: str = Field(min_length=2, max_length=120)
    phone: str | None = Field(default=None, max_length=30)
    county: str = Field(min_length=2, max_length=80)
    sub_county: str | None = Field(default=None, max_length=100)
    cooperative: str | None = Field(default=None, max_length=120)


def clean_optional(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = value.strip()
    return cleaned or None


def farmer_dict(row: sqlite3.Row) -> dict:
    return dict(row)


@app.get("/")
def root():
    return {
        "name": "SukariSol API",
        "version": "0.2.0",
        "status": "running",
    }


@app.get("/api/health")
def health():
    return {
        "status": "healthy",
        "service": "sukarisol-api",
        "database": "sqlite",
    }


@app.get("/api/dashboard")
def dashboard():
    with get_connection() as db:
        farmers = db.execute(
            "SELECT COUNT(*) FROM farmers"
        ).fetchone()[0]

    return {
        "farmers_registered": farmers,
        "farms_registered": 0,
        "pending_collections": 0,
        "deliveries_today": 0,
        "data_mode": "database",
    }


@app.get("/api/farmers")
def list_farmers(
    search: str = Query(default="", max_length=120),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
):
    term = f"%{search.strip()}%"

    with get_connection() as db:
        rows = db.execute(
            """
            SELECT id, farmer_code, full_name, phone, county,
                   sub_county, cooperative, created_at
            FROM farmers
            WHERE full_name LIKE ?
               OR farmer_code LIKE ?
               OR county LIKE ?
               OR COALESCE(cooperative, '') LIKE ?
            ORDER BY id DESC
            LIMIT ? OFFSET ?
            """,
            (term, term, term, term, limit, offset),
        ).fetchall()

        total = db.execute(
            """
            SELECT COUNT(*) FROM farmers
            WHERE full_name LIKE ?
               OR farmer_code LIKE ?
               OR county LIKE ?
               OR COALESCE(cooperative, '') LIKE ?
            """,
            (term, term, term, term),
        ).fetchone()[0]

    return {
        "items": [farmer_dict(row) for row in rows],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@app.post("/api/farmers", status_code=201)
def create_farmer(farmer: FarmerCreate):
    full_name = farmer.full_name.strip()
    county = farmer.county.strip()

    if len(full_name) < 2 or len(county) < 2:
        raise HTTPException(
            status_code=422,
            detail="Enter a valid farmer name and county.",
        )

    now = datetime.now(timezone.utc).isoformat()

    try:
        with get_connection() as db:
            cursor = db.execute(
                """
                INSERT INTO farmers (
                    farmer_code, full_name, phone, county,
                    sub_county, cooperative, created_at
                )
                VALUES ('PENDING', ?, ?, ?, ?, ?, ?)
                """,
                (
                    full_name,
                    clean_optional(farmer.phone),
                    county,
                    clean_optional(farmer.sub_county),
                    clean_optional(farmer.cooperative),
                    now,
                ),
            )

            farmer_id = cursor.lastrowid
            farmer_code = f"SSF-{farmer_id:05d}"

            db.execute(
                "UPDATE farmers SET farmer_code = ? WHERE id = ?",
                (farmer_code, farmer_id),
            )

            row = db.execute(
                "SELECT * FROM farmers WHERE id = ?",
                (farmer_id,),
            ).fetchone()

            return farmer_dict(row)

    except sqlite3.IntegrityError as exc:
        raise HTTPException(
            status_code=409,
            detail="Could not register this farmer.",
        ) from exc


class SmsTestRequest(BaseModel):
    phone_number: str = Field(min_length=10, max_length=13)
    message: str = Field(min_length=1, max_length=480)


def require_sms_api_key(provided_key: str | None) -> None:
    expected_key = os.getenv("SUKARISOL_SMS_API_KEY", "")
    if not expected_key or not provided_key or not secrets.compare_digest(
        expected_key, provided_key
    ):
        raise HTTPException(status_code=401, detail="Invalid or missing API key.")


def sms_gateway_settings():
    gateway_url = os.getenv("SUKARISOL_SMS_GATEWAY_URL", "").rstrip("/")
    username = os.getenv("SUKARISOL_SMS_USERNAME", "")
    password = os.getenv("SUKARISOL_SMS_PASSWORD", "")
    if not all((gateway_url, username, password)):
        raise HTTPException(
            status_code=503,
            detail="SMS gateway configuration is incomplete.",
        )
    if not gateway_url.startswith("http://192.168.100.133:8080"):
        raise HTTPException(
            status_code=503,
            detail="SMS gateway URL is not the configured local gateway.",
        )
    return gateway_url, httpx.BasicAuth(username, password)


@app.post("/api/sms/test", status_code=202)
async def send_test_sms(
    request: SmsTestRequest,
    x_sukarisol_sms_key: str | None = Header(default=None),
):
    require_sms_api_key(x_sukarisol_sms_key)

    phone = request.phone_number.strip()
    if not re.fullmatch(r"\+254[17]\d{8}", phone):
        raise HTTPException(
            status_code=422,
            detail="Use a Kenyan mobile number in +2547XXXXXXXX or +2541XXXXXXXX format.",
        )

    gateway_url, auth = sms_gateway_settings()
    try:
        async with httpx.AsyncClient(
            auth=auth, timeout=httpx.Timeout(10.0)
        ) as client:
            response = await client.post(
                f"{gateway_url}/messages",
                json={
                    "textMessage": {"text": request.message.strip()},
                    "phoneNumbers": [phone],
                },
            )
            response.raise_for_status()
            result = response.json()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"SMS gateway rejected the request (HTTP {exc.response.status_code}).",
        ) from exc
    except (httpx.RequestError, ValueError) as exc:
        raise HTTPException(
            status_code=502,
            detail="Could not communicate with the SMS gateway.",
        ) from exc

    return {
        "status": "accepted",
        "message_id": result.get("id"),
        "gateway_state": result.get("state", "unknown"),
    }


@app.get("/api/sms/status/{message_id}")
async def get_sms_status(
    message_id: str,
    x_sukarisol_sms_key: str | None = Header(default=None),
):
    require_sms_api_key(x_sukarisol_sms_key)

    if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", message_id):
        raise HTTPException(status_code=422, detail="Invalid message ID.")

    gateway_url, auth = sms_gateway_settings()
    try:
        async with httpx.AsyncClient(
            auth=auth, timeout=httpx.Timeout(10.0)
        ) as client:
            response = await client.get(f"{gateway_url}/messages/{message_id}")
            response.raise_for_status()
            result = response.json()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"SMS gateway status request failed (HTTP {exc.response.status_code}).",
        ) from exc
    except (httpx.RequestError, ValueError) as exc:
        raise HTTPException(
            status_code=502,
            detail="Could not retrieve SMS delivery status.",
        ) from exc

    return {
        "message_id": result.get("id", message_id),
        "gateway_state": result.get("state", "unknown"),
    }


async def send_mobilesasa_sms(phone: str, message: str) -> dict:
    api_url = os.getenv(
        "MOBILESASA_API_URL",
        "https://api.mobilesasa.com/v1/send/message",
    ).strip()
    token = os.getenv("MOBILESASA_TOKEN", "").strip()
    sender_id = os.getenv("MOBILESASA_SENDER_ID", "MOBILESASA").strip()

    if not token or not sender_id:
        raise HTTPException(
            status_code=503,
            detail="Mobile Sasa is not fully configured.",
        )

    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(30.0)
        ) as client:
            response = await client.post(
                api_url,
                headers={"Authorization": f"Bearer {token}"},
                json={
                    "senderID": sender_id,
                    "phone": phone,
                    "message": message,
                },
            )
            response.raise_for_status()
            data = response.json()

    except httpx.TimeoutException as exc:
        # The provider might have accepted the message before
        # the timeout. Do not automatically send it again.
        raise HTTPException(
            status_code=504,
            detail=(
                "Mobile Sasa timed out. Check provider status "
                "before retrying to avoid duplicate messages."
            ),
        ) from exc
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=502,
            detail=(
                "Mobile Sasa returned HTTP "
                f"{exc.response.status_code}."
            ),
        ) from exc
    except (httpx.RequestError, ValueError) as exc:
        raise HTTPException(
            status_code=502,
            detail="Could not communicate with Mobile Sasa.",
        ) from exc

    if not isinstance(data, dict) or not data.get("status"):
        code = data.get("responseCode") if isinstance(data, dict) else None
        raise HTTPException(
            status_code=502,
            detail=f"Mobile Sasa rejected the request (code: {code}).",
        )

    return {
        "status": "accepted",
        "provider": "mobilesasa",
        "provider_response_code": data.get("responseCode"),
        "provider_message": data.get("message"),
    }


@app.get("/api/geospatial/agricultural-polygons")
async def discover_agricultural_polygons(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    radius: int = Query(default=3000, ge=250, le=5000),
):
    """Return mapped agricultural polygons near a searched location."""
    query = f"""
    [out:json][timeout:20];
    (
      way(around:{radius},{lat},{lon})["landuse"~"^(farmland|orchard|vineyard|allotments|greenhouse_horticulture)$"];
      way(around:{radius},{lat},{lon})["crop"~"sugarcane|sugar cane",i];
    );
    out tags geom;
    """

    import asyncio

    endpoints = [
        "https://overpass-api.de/api/interpreter",
        "https://overpass.kumi.systems/api/interpreter",
        "https://overpass.private.coffee/api/interpreter",
    ]

    payload = None
    last_error = None

    for attempt, endpoint in enumerate(endpoints):
        if attempt:
            await asyncio.sleep(2 ** (attempt - 1))

        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(20.0),
                headers={
                    "User-Agent": "SukariSol/0.2 (agricultural field discovery)"
                },
            ) as client:
                response = await client.post(
                    endpoint,
                    data={"data": query},
                )
                response.raise_for_status()
                payload = response.json()
                break
        except (httpx.HTTPError, ValueError) as exc:
            last_error = exc

    if payload is None:
        raise HTTPException(
            status_code=502,
            detail=(
                "Agricultural mapping services are temporarily busy. "
                "Please retry shortly or draw/import the field boundary manually."
            ),
        ) from last_error

    features = []

    for element in payload.get("elements", []):
        if element.get("type") != "way":
            continue

        geometry = element.get("geometry", [])
        if len(geometry) < 4:
            continue

        coordinates = [
            [point["lon"], point["lat"]]
            for point in geometry
            if "lon" in point and "lat" in point
        ]

        if len(coordinates) < 4:
            continue

        if coordinates[0] != coordinates[-1]:
            coordinates.append(coordinates[0])

        tags = element.get("tags", {})
        features.append({
            "type": "Feature",
            "id": f"osm-way-{element['id']}",
            "properties": {
                "osm_id": element["id"],
                "name": tags.get("name") or tags.get("crop") or tags.get("landuse") or "Mapped agricultural area",
                "landuse": tags.get("landuse", "agricultural"),
                "crop": tags.get("crop", ""),
                "source": "OpenStreetMap",
                "boundary_status": "Mapped agricultural area; not a verified farm parcel",
            },
            "geometry": {
                "type": "Polygon",
                "coordinates": [coordinates],
            },
        })

    return {
        "type": "FeatureCollection",
        "features": features,
        "count": len(features),
        "source": "OpenStreetMap",
        "radius_metres": radius,
        "notice": "These are mapped agricultural areas, not guaranteed individual farm boundaries.",
    }
