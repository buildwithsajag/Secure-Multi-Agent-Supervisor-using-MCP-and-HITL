let currentThreadId = localStorage.getItem("travel_thread_id") || null;
let latestAnswerMarkdown = "";
let waitingForApproval = false;

const AGENT_LABELS = {
  flight_agent: "✈️ Flight Agent",
  hotel_agent: "🏨 Hotel Agent",
  weather_agent: "🌦️ Weather Agent",
  budget_agent: "💰 Budget Agent",
  itinerary_agent: "🗓️ Itinerary Agent"
};

function setPrompt(text) {
  document.getElementById("userInput").value = text;
}

function setLoading(isLoading, mode = "draft") {
  const sendBtn = document.getElementById("sendBtn");
  const btnText = document.getElementById("btnText");
  const btnLoader = document.getElementById("btnLoader");
  const approveBtn = document.getElementById("approveBtn");
  const reviseBtn = document.getElementById("reviseBtn");

  sendBtn.disabled = isLoading;
  approveBtn.disabled = isLoading;
  reviseBtn.disabled = isLoading;

  if (isLoading && mode === "draft") {
    btnText.classList.add("hidden");
    btnLoader.classList.remove("hidden");
  } else {
    btnText.classList.remove("hidden");
    btnLoader.classList.add("hidden");
  }
}

function showError(message) {
  const errorBox = document.getElementById("errorBox");
  errorBox.textContent = message;
  errorBox.classList.remove("hidden");
  errorBox.scrollIntoView({ behavior: "smooth", block: "center" });
}

function hideError() {
  const errorBox = document.getElementById("errorBox");
  errorBox.classList.add("hidden");
  errorBox.textContent = "";
}

function appendProgress(message) {
  const progressLog = document.getElementById("progressLog");
  const line = document.createElement("p");
  line.textContent = message;
  progressLog.appendChild(line);
  progressLog.classList.remove("hidden");
}

function stageLabel(stage) {
  const labels = {
    supervisor: "Supervisor",
    guardrail_blocked: "Guardrail",
    flight_agent: "Flights",
    hotel_agent: "Hotels",
    weather_agent: "Weather",
    budget_agent: "Budget",
    itinerary_agent: "Itinerary",
    final_agent: "Final plan"
  };
  return labels[stage] || stage.replaceAll("_", " ");
}

function renderMarkdown(element, markdown) {
  if (typeof marked !== "undefined") {
    element.innerHTML = marked.parse(markdown || "");
  } else {
    element.innerText = markdown || "";
  }
}

function showWorkflow(data) {
  const section = document.getElementById("workflowSection");
  const reasoning = document.getElementById("supervisorReasoning");
  const chips = document.getElementById("agentChips");
  const guardrailBadge = document.getElementById("guardrailBadge");

  reasoning.textContent = data.supervisor_reasoning || "Supervisor routing completed.";
  chips.innerHTML = "";

  (data.selected_agents || []).forEach((agent) => {
    const chip = document.createElement("span");
    chip.className = "agent-chip";
    chip.textContent = AGENT_LABELS[agent] || agent;
    chips.appendChild(chip);
  });

  if (data.guardrail_allowed === false) {
    guardrailBadge.textContent = "Guardrail blocked";
    guardrailBadge.classList.add("blocked");
  } else {
    guardrailBadge.textContent = "Guardrail passed";
    guardrailBadge.classList.remove("blocked");
  }

  section.classList.remove("hidden");
}

function showResult(answer, threadId, isDraft = false) {
  latestAnswerMarkdown = answer || "";

  const resultSection = document.getElementById("resultSection");
  const resultBox = document.getElementById("resultBox");
  const threadInfo = document.getElementById("threadInfo");
  const resultTitle = document.getElementById("resultTitle");

  renderMarkdown(resultBox, latestAnswerMarkdown);
  threadInfo.textContent = `Thread ID: ${threadId}`;
  resultTitle.textContent = isDraft ? "Draft Travel Plan" : "Your Final AI Travel Plan";
  resultSection.classList.remove("hidden");

  resultSection.scrollIntoView({
    behavior: "smooth",
    block: "start"
  });
}

function showApproval(data) {
  waitingForApproval = true;
  const section = document.getElementById("approvalSection");
  const approvalRequest = document.getElementById("approvalRequest");
  approvalRequest.textContent = data.approval_request ||
    "Approve the draft or provide feedback before the final plan is generated.";
  section.classList.remove("hidden");
}

function hideApproval() {
  waitingForApproval = false;
  document.getElementById("approvalSection").classList.add("hidden");
  document.getElementById("approvalFeedback").value = "";
}

async function sendMessage() {
  hideError();

  if (waitingForApproval) {
    showError("Please approve or revise the current draft before starting another plan.");
    return;
  }

  const input = document.getElementById("userInput");
  const message = input.value.trim();

  if (!message) {
    showError("Please enter your travel request first.");
    return;
  }

  setLoading(true, "draft");
  const progressLog = document.getElementById("progressLog");
  progressLog.innerHTML = "";
  progressLog.classList.remove("hidden");

  try {
    const response = await fetch("/plan/stream", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message: message,
        thread_id: currentThreadId
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || "Something went wrong.");
    }

    if (!response.body) {
      throw new Error("Streaming response is not available in this browser.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalReceived = false;

    const processEvents = (chunk) => {
      buffer += chunk;
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";

      for (const eventText of events) {
        const dataLine = eventText
          .split("\n")
          .find((line) => line.startsWith("data:"));
        if (!dataLine) continue;

        const event = JSON.parse(dataLine.slice(5).trim());
        if (event.status === "error") {
          throw new Error(event.error || "The travel plan could not be generated.");
        }

        if (event.stage === "final") {
          finalReceived = true;
          currentThreadId = event.thread_id;
          localStorage.setItem("travel_thread_id", currentThreadId);
          showWorkflow(event);

          if (event.requires_approval) {
            showResult(event.itinerary || event.result, event.thread_id, true);
            showApproval(event);
          } else {
            hideApproval();
            showResult(event.result || event.answer, event.thread_id, false);
          }
          continue;
        }

        appendProgress(`✅ ${stageLabel(event.stage)} done`);
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      processEvents(decoder.decode(value, { stream: true }));
    }
    processEvents(decoder.decode());

    if (!finalReceived) {
      throw new Error("The stream ended before the final travel plan arrived.");
    }
  } catch (error) {
    showError(error.message);
  } finally {
    setLoading(false, "draft");
  }
}

async function submitApproval(approved) {
  hideError();

  if (!currentThreadId || !waitingForApproval) {
    showError("There is no draft waiting for approval.");
    return;
  }

  const feedbackInput = document.getElementById("approvalFeedback");
  const feedback = feedbackInput.value.trim();

  if (!approved && !feedback) {
    showError("Please enter revision feedback before requesting changes.");
    feedbackInput.focus();
    return;
  }

  setLoading(true, "approval");

  try {
    const response = await fetch("/api/travel/approve", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        thread_id: currentThreadId,
        approved: approved,
        feedback: feedback
      })
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.error || "Could not resume the travel workflow.");
    }

    showWorkflow(data);
    hideApproval();
    showResult(data.answer, data.thread_id, false);
  } catch (error) {
    showError(error.message);
  } finally {
    setLoading(false, "approval");
  }
}

function copyResult() {
  const resultBox = document.getElementById("resultBox");
  const text = resultBox.innerText;

  if (!text) {
    return;
  }

  navigator.clipboard.writeText(text)
    .then(() => {
      const copyBtn = document.querySelector(".copy-btn");
      const oldText = copyBtn.textContent;
      copyBtn.textContent = "Copied!";

      setTimeout(() => {
        copyBtn.textContent = oldText;
      }, 1400);
    })
    .catch(() => {
      showError("Could not copy result.");
    });
}

function downloadPDF() {
  const pdfContent = document.getElementById("pdfContent");

  if (!latestAnswerMarkdown || !pdfContent) {
    showError("No travel plan available to download.");
    return;
  }

  const downloadBtn = document.querySelector(".download-btn");
  const oldText = downloadBtn.textContent;
  downloadBtn.textContent = "Preparing PDF...";
  downloadBtn.disabled = true;

  const options = {
    margin: 0.5,
    filename: "ai-travel-plan.pdf",
    image: {
      type: "jpeg",
      quality: 0.98
    },
    html2canvas: {
      scale: 2,
      useCORS: true,
      backgroundColor: "#ffffff"
    },
    jsPDF: {
      unit: "in",
      format: "a4",
      orientation: "portrait"
    },
    pagebreak: {
      mode: ["avoid-all", "css", "legacy"]
    }
  };

  html2pdf()
    .set(options)
    .from(pdfContent)
    .save()
    .then(() => {
      downloadBtn.textContent = oldText;
      downloadBtn.disabled = false;
    })
    .catch(() => {
      downloadBtn.textContent = oldText;
      downloadBtn.disabled = false;
      showError("Could not download PDF.");
    });
}

document.addEventListener("keydown", function(event) {
  if (event.ctrlKey && event.key === "Enter") {
    sendMessage();
  }
});