import { useEffect, useState } from "react";
import { json, useFetcher, useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Button,
  BlockStack,
  FormLayout,
  TextField,
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// === LOADER ===
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  const sessionData = await prisma.loyalty.findFirst({
    where: { shop: session.shop },
  });

  if (!sessionData) {
    return json({
      loyaltyEngageID: '',
      loyaltyEngageSecret: '',
      E_Mail_Address: '',
      loyalty_Password: '',
    });
  }

  const {
    loyaltyEngageID,
    loyaltyEngageSecret,
    E_Mail_Address,
    loyalty_Password,
  } = sessionData;

  return json({
    loyaltyEngageID,
    loyaltyEngageSecret,
    E_Mail_Address,
    loyalty_Password,
  });
};

// === ACTION WITH UNIQUE CONSTRAINT CHECK ===
export const action = async ({ request }) => {
  try {
    const { session } = await authenticate.admin(request);
    const { shop } = session;
    const formdata = await request.formData();

    const EngageSecret = formdata.get("loyaltyEngageSecret");
    const EngageID = formdata.get("loyaltyEngageID");
    const EngageEmail = formdata.get("loyaltyEngageEmail");
    const password = formdata.get("loyalty_Password");


    const existing = await prisma.loyalty.findFirst({
      where: {
        shop: shop,
      },
    });
    console.log(existing, "this existing")

    if (existing) {
      // Update current session
      console.log(EngageEmail, "this E EngageEmail")
      await prisma.loyalty.update({
        where: { id: existing.id },
        data: {
          shop,
          loyaltyEngageID: EngageID,
          loyaltyEngageSecret: EngageSecret,
          E_Mail_Address: EngageEmail,
          loyalty_Password: password,
        },
      });
    } else {
      // Create new session with Engage info
      await prisma.loyalty.create({
        data: {
          shop,
          loyaltyEngageID: EngageID,
          loyaltyEngageSecret: EngageSecret,
          E_Mail_Address: EngageEmail,
          loyalty_Password: password,
        },
      });
    }


    return json({
      status: "success",
      message: "Loyalty data saved successfully",
    });
  } catch (error) {
    console.error("Error processing form data:", error);
    return json(
      { status: "error", message: "Failed to process request" },
      { status: 500 }
    );
  }
};

// === COMPONENT ===
export default function Index() {
  const {
    loyaltyEngageID: clientID,
    loyaltyEngageSecret: clientSecret,
    E_Mail_Address: clientEmail,
    loyalty_Password: Password,
  } = useLoaderData();

  const fetcher = useFetcher();

  const [loyaltyEngageID, setLoyaltyEngageID] = useState(clientID);
  const [loyaltyEngageSecret, setLoyaltyEngageSecret] = useState(clientSecret);
  const [loyaltyEngageEmail, setLoyaltyEngageEmail] = useState(clientEmail);
  const [loyalty_Password, setLoyalty_Password] = useState(Password);
  const [btnDisabled, setBtnDisabled] = useState(true);
  const [successBanner, setSuccessBanner] = useState(false);
  const [errorBanner, setErrorBanner] = useState("");

  useEffect(() => {
    const changed =
      loyaltyEngageID !== clientID ||
      loyaltyEngageSecret !== clientSecret ||
      loyaltyEngageEmail !== clientEmail ||
      loyalty_Password !== Password;

    setBtnDisabled(!changed);
  }, [
    loyaltyEngageID,
    loyaltyEngageSecret,
    loyaltyEngageEmail,
    loyalty_Password,
    clientID,
    clientSecret,
    clientEmail,
    Password,
  ]);

  useEffect(() => {
    if (fetcher.data?.status === "success") {
      setSuccessBanner(true);
      setErrorBanner("");
    } else if (fetcher.data?.status === "error") {
      setErrorBanner(fetcher.data?.message || "Something went wrong.");
      setSuccessBanner(false);
    }
  }, [fetcher.data]);

  return (
    <Page

     primaryAction={{
      content: "Loyalty Dashboard",
      target:"_blank",
      url: "https://app.loyaltyengage.tech/",
      external: true,
    }}

    >
      <TitleBar title="Loyalty APP" />

      {successBanner && (
        <Banner
          title="Success"
          status="success"
          onDismiss={() => setSuccessBanner(false)}
        >
          <p>Loyalty data saved successfully.</p>
        </Banner>
      )}

      {errorBanner && (
        <Banner
          title="Error"
          status="critical"
          onDismiss={() => setErrorBanner("")}
        >
          <p>{errorBanner}</p>
        </Banner>
      )}

      <BlockStack gap="500">
        <Layout.Section>
          <Card sectioned>
            <fetcher.Form
              method="post"
              encType="multipart/form-data"
              onSubmit={(e) => {
                e.preventDefault();

                const formData = new FormData();
                formData.append("loyaltyEngageID", loyaltyEngageID);
                formData.append("loyaltyEngageSecret", loyaltyEngageSecret);
                formData.append("loyaltyEngageEmail", loyaltyEngageEmail);
                formData.append("loyalty_Password", loyalty_Password);

                fetcher.submit(formData, {
                  method: "post",
                  encType: "multipart/form-data",
                });
              }}
            >
              <FormLayout>
                <TextField
                  label="Loyalty Engage ID"
                  value={loyaltyEngageID}
                  onChange={setLoyaltyEngageID}
                  autoComplete="off"
                />
                <TextField
                  label="Loyalty Engage Secret"
                  value={loyaltyEngageSecret}
                  onChange={setLoyaltyEngageSecret}
                  autoComplete="off"
                />
                <TextField
                  label="Add your loyalty engage Email"
                  value={loyaltyEngageEmail}
                  onChange={setLoyaltyEngageEmail}
                  autoComplete="off"
                />
                <TextField
                  label="Add your loyalty engage Password"
                  value={loyalty_Password}
                  onChange={setLoyalty_Password}
                  autoComplete="off"
                />
                <Button
                  primary
                  submit
                  disabled={btnDisabled}
                  loading={fetcher.state !== "idle"}
                >
                  Save
                </Button>
              </FormLayout>
            </fetcher.Form>
          </Card>
        </Layout.Section>
      </BlockStack>
    </Page>
  );
}
