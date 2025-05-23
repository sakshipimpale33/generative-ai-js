/**
 * @license
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  Content,
  GenerateContentRequest,
  GenerateContentResult,
  GenerateContentStreamResult,
  Part,
  RequestOptions,
  SingleRequestOptions,
  StartChatParams,
} from "../../types";
import { formatNewContent } from "../requests/request-helpers";
import { formatBlockErrorMessage } from "../requests/response-helpers";
import { isValidResponse, validateChatHistory } from "./chat-session-helpers";
import { generateContent, generateContentStream } from "./generate-content";

/**
 * Do not log a message for this error.
 */
const SILENT_ERROR = "SILENT_ERROR";

/**
 * ChatSession class that enables sending chat messages and stores
 * history of sent and received messages so far.
 *
 * @public
 */
export class ChatSession {
  private _apiKey: string;
  private _history: Content[] = [];
  private _sendPromise: Promise<void> = Promise.resolve();

  constructor(
    apiKey: string,
    public model: string,
    public params?: StartChatParams,
    private _requestOptions: RequestOptions = {},
  ) {
    this._apiKey = apiKey;
    if (params?.history) {
      validateChatHistory(params.history);
      this._history = params.history;
    }
  }

  /**
   * Gets the chat history so far. Blocked prompts are not added to history.
   * Blocked candidates are not added to history, nor are the prompts that
   * generated them.
   */
  async getHistory(): Promise<Content[]> {
    await this._sendPromise;
    return this._history;
  }

  /**
   * Sends a chat message and receives a non-streaming
   * {@link GenerateContentResult}.
   *
   * Fields set in the optional {@link SingleRequestOptions} parameter will
   * take precedence over the {@link RequestOptions} values provided to
   * {@link GoogleGenerativeAI.getGenerativeModel }.
   */
  async sendMessage(
    request: string | Array<string | Part>,
    requestOptions: SingleRequestOptions = {},
  ): Promise<GenerateContentResult> {
    await this._sendPromise;
    const newContent = formatNewContent(request);
    const generateContentRequest: GenerateContentRequest = {
      safetySettings: this.params?.safetySettings,
      generationConfig: this.params?.generationConfig,
      tools: this.params?.tools,
      toolConfig: this.params?.toolConfig,
      systemInstruction: this.params?.systemInstruction,
      cachedContent: this.params?.cachedContent,
      contents: [...this._history, newContent],
    };
    const chatSessionRequestOptions: SingleRequestOptions = {
      ...this._requestOptions,
      ...requestOptions,
    };
    let finalResult;
    // Add onto the chain.
    this._sendPromise = this._sendPromise
      .then(() =>
        generateContent(
          this._apiKey,
          this.model,
          generateContentRequest,
          chatSessionRequestOptions,
        ),
      )
      .then((result) => {
        if (isValidResponse(result.response)) {
          this._history.push(newContent);
          const responseContent: Content = {
            parts: [],
            // Response seems to come back without a role set.
            role: "model",
            ...result.response.candidates?.[0].content,
          };
          this._history.push(responseContent);
        } else {
          const blockErrorMessage = formatBlockErrorMessage(result.response);
          if (blockErrorMessage) {
            console.warn(
              `sendMessage() was unsuccessful. ${blockErrorMessage}. Inspect response object for details.`,
            );
          }
        }
        finalResult = result;
      })
      .catch((e) => {
        // Resets _sendPromise to avoid subsequent calls failing and throw error.
        this._sendPromise = Promise.resolve();
        throw e;
      });
    await this._sendPromise;
    return finalResult;
  }

  /**
   * Sends a chat message and receives the response as a
   * {@link GenerateContentStreamResult} containing an iterable stream
   * and a response promise.
   *
   * Fields set in the optional {@link SingleRequestOptions} parameter will
   * take precedence over the {@link RequestOptions} values provided to
   * {@link GoogleGenerativeAI.getGenerativeModel }.
   */
  async sendMessageStream(
    request: string | Array<string | Part>,
    requestOptions: SingleRequestOptions = {},
  ): Promise<GenerateContentStreamResult> {
    await this._sendPromise;
    const newContent = formatNewContent(request);
    const generateContentRequest: GenerateContentRequest = {
      safetySettings: this.params?.safetySettings,
      generationConfig: this.params?.generationConfig,
      tools: this.params?.tools,
      toolConfig: this.params?.toolConfig,
      systemInstruction: this.params?.systemInstruction,
      cachedContent: this.params?.cachedContent,
      contents: [...this._history, newContent],
    };
    const chatSessionRequestOptions: SingleRequestOptions = {
      ...this._requestOptions,
      ...requestOptions,
    };
    const streamPromise = generateContentStream(
      this._apiKey,
      this.model,
      generateContentRequest,
      chatSessionRequestOptions,
    );

    // Add onto the chain.
    this._sendPromise = this._sendPromise
      .then(() => streamPromise)
      // This must be handled to avoid unhandled rejection, but jump
      // to the final catch block with a label to not log this error.
      .catch((_ignored) => {
        throw new Error(SILENT_ERROR);
      })
      .then((streamResult) => streamResult.response)
      .then((response) => {
        if (isValidResponse(response)) {
          this._history.push(newContent);
          const responseContent = { ...response.candidates[0].content };
          // Response seems to come back without a role set.
          if (!responseContent.role) {
            responseContent.role = "model";
          }
          this._history.push(responseContent);
        } else {
          const blockErrorMessage = formatBlockErrorMessage(response);
          if (blockErrorMessage) {
            console.warn(
              `sendMessageStream() was unsuccessful. ${blockErrorMessage}. Inspect response object for details.`,
            );
          }
        }
      })
      .catch((e) => {
        // Errors in streamPromise are already catchable by the user as
        // streamPromise is returned.
        // Avoid duplicating the error message in logs.
        if (e.message !== SILENT_ERROR) {
          // Users do not have access to _sendPromise to catch errors
          // downstream from streamPromise, so they should not throw.
          console.error(e);
        }
      });
    return streamPromise;
  }
}
