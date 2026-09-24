import httpx


class OllamaClient:
    def __init__(
        self,
        base_url: str = "http://127.0.0.1:11434",
        model: str = "qwen3:8b",
        timeout: float = 600.0,
    ):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout

    def health(self) -> bool:
        try:
            response = httpx.get(
                f"{self.base_url}/api/tags",
                timeout=10.0,
            )

            return response.is_success

        except Exception:
            return False

    def chat(
        self,
        system: str,
        user: str,
        temperature: float = 0.0,
    ) -> str:

        payload = {
            "model": self.model,
            "stream": False,
            "messages": [
                {
                    "role": "system",
                    "content": system,
                },
                {
                    "role": "user",
                    "content": user,
                },
            ],
            "options": {
                "temperature": temperature,

                # الحد الأقصى لطول الإجابة
                "num_predict": 1500,

                # مهم:
                # إجبار Ollama على CPU لتجنب مشكلة CUDA
                "num_gpu": 0,
            },
        }

        timeout = httpx.Timeout(
            connect=30.0,
            read=self.timeout,
            write=60.0,
            pool=30.0,
        )

        try:
            with httpx.Client(timeout=timeout) as client:
                response = client.post(
                    f"{self.base_url}/api/chat",
                    json=payload,
                )

            response.raise_for_status()

            data = response.json()

            message = data.get("message", {})
            content = message.get("content", "")

            if not content:
                raise RuntimeError(
                    "Ollama returned an empty response."
                )

            return content.strip()

        except httpx.ReadTimeout as exc:
            raise RuntimeError(
                f"Ollama model '{self.model}' took too long to respond. "
                "The model may be too heavy for the current machine."
            ) from exc

        except httpx.ConnectError as exc:
            raise RuntimeError(
                "Cannot connect to Ollama. "
                "Make sure Ollama is running on "
                f"{self.base_url}."
            ) from exc

        except httpx.HTTPStatusError as exc:
            response_text = ""

            try:
                response_text = exc.response.text
            except Exception:
                pass

            raise RuntimeError(
                f"Ollama returned HTTP "
                f"{exc.response.status_code}.\n"
                f"{response_text}"
            ) from exc

        except Exception as exc:
            raise RuntimeError(
                f"Ollama error while using model "
                f"'{self.model}': {exc}"
            ) from exc