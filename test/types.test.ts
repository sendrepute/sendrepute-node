import {
  SendReputeClient,
  type CustomerClassificationInput,
  type CustomerClassificationResponse,
  type OperationInput,
  type OperationResponse,
} from "../src/index.js";

declare const client: SendReputeClient;

const body: CustomerClassificationInput = {
  sender: "Sender",
  subject: "Subject",
  body: "Body",
};
const input: OperationInput<"classifyCustomerEmail"> = { body };
const response: Promise<CustomerClassificationResponse> = client.request("classifyCustomerEmail", input);
const sameResponse: Promise<OperationResponse<"classifyCustomerEmail">> = response;
void sameResponse;