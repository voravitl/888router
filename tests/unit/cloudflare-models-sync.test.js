import { describe, it, expect } from "vitest";
import { parseCloudflareModelsResponse } from "../../src/lib/cloudflareAiModels.js";

describe("Cloudflare Workers AI Model Sync Parser", () => {
  it("parses modern Cloudflare API with task object { id, name } and @cf/ slug in name", () => {
    const mockApiResponse = {
      result: [
        {
          id: "b37a188f-1234-5678-90ab-cdef12345678",
          name: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
          description: "Llama 3.3 70B Instruct",
          task: { id: "c018258b-9012-3456-789a-bcdef0123456", name: "Text Generation" }
        },
        {
          id: "d48b299f-2345-6789-01bc-defa23456789",
          name: "@cf/black-forest-labs/flux-1-schnell",
          description: "FLUX.1 Schnell",
          task: { id: "e59c300a-3456-7890-12cd-efab34567890", name: "Text-to-Image" }
        },
        {
          id: "f50d411b-4567-8901-23de-fabc45678901",
          name: "@cf/openai/whisper",
          description: "Whisper Speech Recognition",
          task: { id: "a61e522c-5678-9012-34ef-abcd56789012", name: "Automatic Speech Recognition" }
        }
      ]
    };

    const parsed = parseCloudflareModelsResponse(mockApiResponse);

    expect(parsed).toEqual([
      {
        id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        name: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        description: "Llama 3.3 70B Instruct",
        kind: "llm"
      },
      {
        id: "@cf/black-forest-labs/flux-1-schnell",
        name: "@cf/black-forest-labs/flux-1-schnell",
        description: "FLUX.1 Schnell",
        kind: "image"
      }
    ]);
  });

  it("parses legacy Cloudflare API with boolean task flags", () => {
    const mockLegacyApiResponse = {
      result: [
        {
          id: "@cf/meta/llama-3.1-8b-instruct",
          name: "Llama 3.1 8B",
          description: "Llama 3.1 8B Instruct",
          task: { "text-generation": true }
        },
        {
          id: "@cf/bytedance/stable-diffusion-xl-lightning",
          name: "SDXL Lightning",
          description: "SDXL Lightning Image Gen",
          task: { "text-to-image": true }
        }
      ]
    };

    const parsed = parseCloudflareModelsResponse(mockLegacyApiResponse);

    expect(parsed).toEqual([
      {
        id: "@cf/meta/llama-3.1-8b-instruct",
        name: "Llama 3.1 8B",
        description: "Llama 3.1 8B Instruct",
        kind: "llm"
      },
      {
        id: "@cf/bytedance/stable-diffusion-xl-lightning",
        name: "SDXL Lightning",
        description: "SDXL Lightning Image Gen",
        kind: "image"
      }
    ]);
  });

  it("parses @hf/ HuggingFace slugs (HF task.name like Image-to-Text)", () => {
    const mockHfResponse = {
      result: [
        {
          id: "abc12345-1234-5678-9abc-def012345678",
          name: "@hf/thebloke/deepseek-coder-6.7b-instruct",
          description: "DeepSeek Coder 6.7B",
          task: { name: "Image-to-Text" }
        },
        {
          id: "fed98765-4321-8765-cdef-1234567890ab",
          name: "LLaVA 1.5",
          description: "Visual Question Answering",
          task: { name: "Visual Question Answering" }
        },
        {
          id: "11122233-4444-5555-6666-777788889999",
          name: "Speech Recognition",
          description: "Whisper",
          task: { name: "Automatic Speech Recognition" }
        }
      ]
    };

    const parsed = parseCloudflareModelsResponse(mockHfResponse);

    expect(parsed).toEqual([
      {
        id: "@hf/thebloke/deepseek-coder-6.7b-instruct",
        name: "@hf/thebloke/deepseek-coder-6.7b-instruct",
        description: "DeepSeek Coder 6.7B",
        kind: "llm"
      },
      {
        id: "LLaVA 1.5",
        name: "LLaVA 1.5",
        description: "Visual Question Answering",
        kind: "llm"
      }
    ]);
  });

  it("skips raw UUIDs and falls back to friendly name when slug is unavailable", () => {
    const mockUuidResponse = {
      result: [
        {
          id: "550e8400-e29b-41d4-a716-446655440000",
          name: "Llama 3.3 70B",
          description: "LLaMA 3.3 70B",
          task: { name: "Text Generation" }
        }
      ]
    };

    const parsed = parseCloudflareModelsResponse(mockUuidResponse);

    expect(parsed).toEqual([
      {
        id: "Llama 3.3 70B",
        name: "Llama 3.3 70B",
        description: "LLaMA 3.3 70B",
        kind: "llm"
      }
    ]);
  });

  it("filters out non-LLM/non-image tasks (embeddings, ASR, translation)", () => {
    const mockFilteredResponse = {
      result: [
        {
          id: "11111111-2222-3333-4444-555555555555",
          name: "Embedding Model",
          task: { name: "Embedding" }
        },
        {
          id: "22222222-3333-4444-5555-666666666666",
          name: "Whisper",
          task: { name: "Automatic Speech Recognition" }
        },
        {
          id: "33333333-4444-5555-6666-777777777777",
          name: "Translator",
          task: { name: "Translation" }
        }
      ]
    };

    const parsed = parseCloudflareModelsResponse(mockFilteredResponse);

    expect(parsed).toEqual([]);
  });
});
