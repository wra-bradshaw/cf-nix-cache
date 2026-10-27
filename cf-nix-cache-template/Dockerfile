# Wrangler builds this on deploy and pushes it to the account's container
# registry. It adds no layers to the pre-built processor image, which the
# PROCESSOR_IMAGE build variable in wrangler.jsonc pins by digest. The default
# only names the setting in the pull error if that variable is missing.
ARG PROCESSOR_IMAGE=set-processor-image-in-wrangler-jsonc
FROM ${PROCESSOR_IMAGE}
EXPOSE 8080
