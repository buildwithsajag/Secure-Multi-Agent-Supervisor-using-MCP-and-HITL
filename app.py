from pathlib import Path
import json
import traceback
import uuid

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field

from backend import (
    _empty_constraints,
    _serialize_result,
    resume_travel_agent,
    run_travel_agent,
    travel_graph,
)
from langchain_core.messages import HumanMessage

# This is kept from the original project to allow the existing synchronous
# agent functions to call async MCP helpers inside FastAPI.
import nest_asyncio

nest_asyncio.apply()

BASE_DIR = Path(__file__).resolve().parent

app = FastAPI(
    title="Himalayan Voyager AI",
    description=(
        "LangGraph Multi-Agent Travel Planner with Supervisor, Guardrails, "
        "Human-in-the-Loop, and FastAPI Frontend"
    ),
    version="2.0.0",
)

app.mount(
    "/static",
    StaticFiles(directory=str(BASE_DIR / "static")),
    name="static",
)

templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))


class TravelRequest(BaseModel):
    message: str
    thread_id: str | None = None


class ApprovalRequest(BaseModel):
    thread_id: str = Field(min_length=1)
    approved: bool
    feedback: str = ""


def _sse_event(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _node_preview(node_name: str, output: dict) -> str:
    preview_fields = {
        "supervisor": "supervisor_reasoning",
        "guardrail_blocked": "final_response",
        "flight_agent": "flight_results",
        "hotel_agent": "hotel_results",
        "weather_agent": "weather_results",
        "budget_agent": "budget_results",
        "itinerary_agent": "itinerary",
        "final_agent": "final_response",
    }
    preview = output.get(preview_fields.get(node_name, ""), "")
    if not preview:
        preview = next(
            (value for value in output.values() if isinstance(value, str)),
            f"{node_name} completed.",
        )
    return str(preview)[:200]


@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={},
    )


@app.post("/api/travel")
async def travel_planner(request_data: TravelRequest):
    try:
        user_message = request_data.message.strip()

        if not user_message:
            return JSONResponse(
                status_code=400,
                content={
                    "success": False,
                    "error": "Message cannot be empty.",
                },
            )

        result = run_travel_agent(
            user_input=user_message,
            thread_id=request_data.thread_id,
        )

        return JSONResponse(
            content={
                "success": True,
                **result,
            }
        )

    except Exception as exc:
        print("ERROR:", exc)
        traceback.print_exc()

        return JSONResponse(
            status_code=500,
            content={
                "success": False,
                "error": str(exc),
            },
        )


@app.post("/plan/stream")
async def stream_travel_plan(request_data: TravelRequest):
    user_message = request_data.message.strip()
    if not user_message:
        return JSONResponse(
            status_code=400,
            content={
                "success": False,
                "error": "Message cannot be empty.",
            },
        )

    thread_id = request_data.thread_id or f"user_{uuid.uuid4().hex}"
    config = {"configurable": {"thread_id": thread_id}}
    initial_state = {
        "messages": [HumanMessage(content=user_message)],
        "user_query": user_message,
        "guardrail_allowed": True,
        "guardrail_reason": "",
        "selected_agents": [],
        "trip_constraints": _empty_constraints(),
        "supervisor_reasoning": "",
        "flight_results": "",
        "hotel_results": "",
        "weather_results": "",
        "budget_results": "",
        "itinerary": "",
        "approval_request": "",
        "approved": False,
        "human_feedback": "",
        "final_response": "",
        "llm_calls": 0,
    }

    async def event_stream():
        state = dict(initial_state)
        try:
            async for update in travel_graph.astream(
                initial_state,
                config=config,
                stream_mode="updates",
            ):
                for node_name, output in update.items():
                    if node_name == "__interrupt__":
                        state[node_name] = output
                        continue
                    if not isinstance(output, dict):
                        continue

                    for key, value in output.items():
                        if key == "messages":
                            state[key] = state.get(key, []) + value
                        else:
                            state[key] = value

                    yield _sse_event(
                        {
                            "stage": node_name,
                            "status": "done",
                            "preview": _node_preview(node_name, output),
                        }
                    )

            result = _serialize_result(state, thread_id)
            if state.get("itinerary"):
                result["answer"] = state["itinerary"]
            result["requires_approval"] = bool(
                state.get("itinerary") and state.get("approval_request")
            )
            yield _sse_event(
                {
                    "stage": "final",
                    "status": "done",
                    "result": result["answer"],
                    **result,
                }
            )
        except Exception as exc:
            traceback.print_exc()
            yield _sse_event({"stage": "error", "status": "error", "error": str(exc)})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/travel/approve")
async def approve_travel_plan(request_data: ApprovalRequest):
    try:
        if not request_data.approved and not request_data.feedback.strip():
            return JSONResponse(
                status_code=400,
                content={
                    "success": False,
                    "error": "Please provide revision feedback when rejecting the draft.",
                },
            )

        result = resume_travel_agent(
            thread_id=request_data.thread_id,
            approved=request_data.approved,
            feedback=request_data.feedback,
        )

        return JSONResponse(
            content={
                "success": True,
                **result,
            }
        )

    except Exception as exc:
        print("APPROVAL ERROR:", exc)
        traceback.print_exc()

        return JSONResponse(
            status_code=500,
            content={
                "success": False,
                "error": str(exc),
            },
        )


@app.get("/health")
async def health_check():
    return {
        "status": "ok",
        "message": "Himalayan Voyager AI API is running",
        "features": [
            "supervisor_agent",
            "input_guardrail",
            "human_in_the_loop",
        ],
    }


@app.get("/favicon.ico")
async def favicon():
    return JSONResponse(content={})


if __name__ == "__main__":
    uvicorn.run(
        "app:app",
        host="127.0.0.1",
        port=8000,
        reload=True,
    )