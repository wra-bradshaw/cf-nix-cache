# Changesets

Every pull request that changes the published Worker runtime should include a
changeset:

```console
pnpm changeset
```

Choose the semantic-version bump and describe the user-visible change. Changes
that cannot affect the published runtime may use an empty changeset or omit one.

The release workflow turns accumulated changesets into a version PR. Merging
that PR does not publish immediately: a maintainer first runs the protected
`Prepare release artifacts` workflow, which publishes the matching processor
image and opens a second PR pinning its immutable digest. npm publication only
becomes eligible after that digest PR is merged.
