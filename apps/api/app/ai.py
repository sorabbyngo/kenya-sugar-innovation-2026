import os
import logging

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/ai", tags=["AI Advisory"])
logger = logging.getLogger(__name__)

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "").strip()
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "").strip()
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()

GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
OPENROUTER_MODEL = os.getenv("OPENROUTER_MODEL", "openrouter/free")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

SYSTEM_PROMPT = """
You are SukariSol AI, an agricultural adviser supporting Kenya's
sugarcane value chain.

Give concise, practical advice suitable for a farmer in Kenya.
Aim for 3 to 6 short bullet points. Use plain language.
Consider the farmer's location and crop stage.
Never invent weather readings, soil tests, diagnoses, or pesticide dosages.
State uncertainty where necessary.
For pest and disease treatments, advise confirming the diagnosis and
following Kenyan product labels and qualified agricultural extension advice.
Do not reveal private reasoning. Provide only the final answer.
""".strip()


class AdvisoryRequest(BaseModel):
    question: str = Field(min_length=5, max_length=2000)
    county: str = Field(default="Kenya", min_length=2, max_length=80)
    crop_stage: str | None = Field(default=None, max_length=100)


class AdvisoryResponse(BaseModel):
    answer: str
    model: str


def extract_openai_answer(data: dict) -> str:
    return (
        data["choices"][0]["message"]["content"] or ""
    ).strip()


async def call_openai_compatible(
    client: httpx.AsyncClient,
    url: str,
    api_key: str,
    model: str,
    messages: list[dict],
    extra_headers: dict | None = None,
) -> str:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    if extra_headers:
        headers.update(extra_headers)

    response = await client.post(
        url,
        headers=headers,
        json={
            "model": model,
            "messages": messages,
            "temperature": 0.2,
            "max_tokens": 350,
            "stream": False,
        },
    )
    response.raise_for_status()
    answer = extract_openai_answer(response.json())
    if not answer:
        raise ValueError("Provider returned an empty answer")
    return answer


async def call_gemini(
    client: httpx.AsyncClient,
    api_key: str,
    model: str,
    question: str,
) -> str:
    url = (
        "https://generativelanguage.googleapis.com/v1beta/"
        f"models/{model}:generateContent"
    )
    response = await client.post(
        url,
        headers={
            "x-goog-api-key": api_key,
            "Content-Type": "application/json",
        },
        json={
            "system_instruction": {
                "parts": [{"text": SYSTEM_PROMPT}]
            },
            "contents": [
                {
                    "role": "user",
                    "parts": [{"text": question}],
                }
            ],
            "generationConfig": {
                "temperature": 0.2,
                "maxOutputTokens": 350,
            },
        },
    )
    response.raise_for_status()
    data = response.json()
    parts = data["candidates"][0]["content"]["parts"]
    answer = "\n".join(
        part.get("text", "") for part in parts
    ).strip()
    if not answer:
        raise ValueError("Gemini returned an empty answer")
    return answer


@router.post("/advisory", response_model=AdvisoryResponse)
async def get_advisory(request: AdvisoryRequest):
    question = request.question.strip()
    if len(question) < 5:
        raise HTTPException(
            status_code=422,
            detail="Please enter a more specific question.",
        )

    context = (
        f"Farmer location: {request.county.strip()}.\n"
        f"Crop stage: {(request.crop_stage or 'Not specified').strip()}.\n"
        f"Farmer question: {question}"
    )
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": context},
    ]

    # Bound each provider attempt so a failed service cannot hang the demo.
    timeout = httpx.Timeout(8.0, connect=2.5)

    providers = []

    if GROQ_API_KEY:
        providers.append(("Groq", GROQ_MODEL))

    if OPENROUTER_API_KEY:
        providers.append(("OpenRouter", OPENROUTER_MODEL))

    if GEMINI_API_KEY:
        providers.append(("Gemini", GEMINI_MODEL))

    if not providers:
        raise HTTPException(
            status_code=503,
            detail="AI service is not configured. Please contact the administrator.",
        )

    failures = []

    async with httpx.AsyncClient(timeout=timeout) as client:
        for provider, model in providers:
            try:
                if provider == "Groq":
                    answer = await call_openai_compatible(
                        client,
                        "https://api.groq.com/openai/v1/chat/completions",
                        GROQ_API_KEY,
                        model,
                        messages,
                    )

                elif provider == "OpenRouter":
                    answer = await call_openai_compatible(
                        client,
                        "https://openrouter.ai/api/v1/chat/completions",
                        OPENROUTER_API_KEY,
                        model,
                        messages,
                        extra_headers={
                            "HTTP-Referer": "https://sukarisol.local",
                            "X-Title": "SukariSol",
                        },
                    )

                else:
                    answer = await call_gemini(
                        client,
                        GEMINI_API_KEY,
                        model,
                        context,
                    )

                logger.info("AI advisory completed using %s", provider)
                # Keep the existing response contract. The frontend does
                # not need to display this field to the user.
                return AdvisoryResponse(
                    answer=answer,
                    model=f"{provider}/{model}",
                )

            except (httpx.HTTPError, ValueError, KeyError, IndexError,
                    TypeError) as exc:
                # Log provider and exception type only; never log API keys
                # or complete request headers.
                logger.warning(
                    "AI provider %s failed (%s)",
                    provider,
                    type(exc).__name__,
                )
                failures.append(provider)

    logger.error(
        "All configured AI providers failed: %s",
        ", ".join(failures),
    )
    raise HTTPException(
        status_code=503,
        detail=(
            "SukariSol AI is temporarily busy. Please try again shortly."
        ),
    )
