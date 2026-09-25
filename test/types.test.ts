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
const authorizedBody: CustomerClassificationInput = {
  ...body,
  priceAuthorization: {
    expectedPricing: {
      classificationBaseMillicents: 100,
      includedUniqueTerms: 3,
      additionalTermMillicents: 7,
      maximumClassificationMillicents: 500,
    },
    maxChargeMillicents: 425,
  },
};
const input: OperationInput<"classifyCustomerEmail"> = { body };
const response: Promise<CustomerClassificationResponse> = client.request("classifyCustomerEmail", input);
const sameResponse: Promise<OperationResponse<"classifyCustomerEmail">> = response;
void sameResponse;
void authorizedBody;