# Changesets

Every pull request that changes the published Worker runtime should include a
changeset:

```console
pnpm changeset
```

Choose the semantic-version bump and describe the user-visible change. Changes
that cannot affect the published runtime may use an empty changeset or omit one.

The `Release PR` workflow turns accumulated changesets into a version PR. The
same job publishes the matching processor image and pins its immutable digest
in that PR, so merging it publishes the release.
