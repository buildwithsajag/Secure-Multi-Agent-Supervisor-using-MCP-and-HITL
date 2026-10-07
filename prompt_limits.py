from collections.abc import Sequence
from typing import Any


MAX_LLM_INPUT_CHARS = 14_000
_TRUNCATION_MARKER = "\n...[earlier prompt content trimmed]...\n"


def _trim_text(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    if max_chars <= len(_TRUNCATION_MARKER):
        return text[:max_chars]

    retained_chars = max_chars - len(_TRUNCATION_MARKER)
    head_chars = retained_chars // 2
    tail_chars = retained_chars - head_chars
    return (
        text[:head_chars]
        + _TRUNCATION_MARKER
        + (text[-tail_chars:] if tail_chars else "")
    )


def trim_llm_input(prompt: Any) -> Any:
    if isinstance(prompt, str):
        return _trim_text(prompt, MAX_LLM_INPUT_CHARS)
    if not isinstance(prompt, Sequence):
        return prompt

    messages = list(prompt)
    contents = [getattr(message, "content", None) for message in messages]
    if not all(isinstance(content, str) for content in contents):
        return prompt
    if sum(len(content) for content in contents) <= MAX_LLM_INPUT_CHARS:
        return messages

    char_budgets = [0] * len(messages)
    remaining_chars = MAX_LLM_INPUT_CHARS
    system_indices = [
        index
        for index, message in enumerate(messages)
        if getattr(message, "type", None) == "system"
    ]
    other_indices = [
        index for index in range(len(messages)) if index not in system_indices
    ]

    for index in system_indices + list(reversed(other_indices)):
        char_budgets[index] = min(len(contents[index]), remaining_chars)
        remaining_chars -= char_budgets[index]

    return [
        message.model_copy(
            update={"content": _trim_text(content, char_budgets[index])}
        )
        for index, (message, content) in enumerate(zip(messages, contents))
    ]


def invoke_with_prompt_limit(llm: Any, prompt: Any) -> Any:
    return llm.invoke(trim_llm_input(prompt))