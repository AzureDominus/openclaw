# GraphQL Operations (Indeed Employer Candidates)

## CandidateListTotalCount

Use for exact counts by UI-like status filters.

```graphql
query CandidateListTotalCount($input: FindCandidateSubmissionsInput!, $first: Int) {
  findCandidateSubmissions(input: $input, first: $first) {
    totalCount
    __typename
  }
}
```

## CandidateListIds

Use to get candidate legacy IDs + display names for a filtered list.

```graphql
query CandidateListIds($input: FindCandidateSubmissionsInput!, $first: Int) {
  findCandidateSubmissions(input: $input, first: $first) {
    candidateSubmissions {
      id
      data {
        ... on EmployerGeneratedCandidateSubmission {
          legacyID
          __typename
        }
        ... on HiddenEmployerGeneratedCandidateSubmission {
          legacyID
          __typename
        }
        ... on HiddenIndeedApplyCandidateSubmission {
          legacyID
          __typename
        }
        ... on IndeedApplyCandidateSubmission {
          legacyID
          __typename
        }
        profile {
          name {
            displayName
            __typename
          }
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}
```

## CandidateDetails (candidateSubmissions)

Use to fetch profile + resume + supportingFiles per legacy ID.

```graphql
query CandidateDetails($input: CandidateSubmissionsInput!) {
  candidateSubmissions(input: $input) {
    results {
      ... on CandidateSubmission {
        data {
          submissionUuid
          created
          profile {
            name {
              displayName
            }
            contact {
              phoneNumber
              email: aliasedEmail
            }
          }
          milestone {
            milestone {
              milestoneId
              category
            }
            startTime
          }
          resume {
            __typename
            ... on CandidatePdfResume {
              id
              name
              downloadUrl
              txtDownloadUrl
            }
            ... on CandidateHtmlFile {
              id
              name
              downloadUrl
              body
            }
            ... on CandidateTxtFile {
              id
              name
              downloadUrl
              body
            }
            ... on CandidateUnrenderableFile {
              id
              name
              downloadUrl
            }
          }
          supportingFiles {
            attachments {
              __typename
              ... on CandidateHtmlFile {
                body
                downloadUrl
                id
                name
              }
              ... on CandidateTxtFile {
                body
                downloadUrl
                id
                name
              }
              ... on CandidateUnrenderableFile {
                name
                id
                downloadUrl
              }
              ... on CandidatePdfFile {
                downloadUrl
                id
                name
              }
            }
            coverLetter {
              __typename
              ... on CandidateHtmlFile {
                body
                name
                id
                downloadUrl
              }
              ... on CandidateTxtFile {
                body
                name
                id
                downloadUrl
              }
              ... on CandidateUnrenderableFile {
                name
                id
                downloadUrl
              }
              ... on CandidatePdfFile {
                name
                id
                downloadUrl
              }
            }
          }
          ... on EmployerGeneratedCandidateSubmission {
            legacyID
          }
          ... on HiddenEmployerGeneratedCandidateSubmission {
            legacyID
          }
          ... on HiddenIndeedApplyCandidateSubmission {
            legacyID
          }
          ... on IndeedApplyCandidateSubmission {
            legacyID
          }
        }
      }
    }
  }
}
```

## Resume download endpoint

Observed endpoint:

```text
GET https://employers.indeed.com/api/catws/resume/v2/download?id=<legacyId>&indeedcsrftoken=<CSRF>
```

Typical required headers:

- `csrf: <CSRF cookie value>`
- `x-indeed-api: 1`
- `x-indeed-rpc: 1`
- `indeed-client-application: candidates-review`
- `indeed-employer-key: <employer key>`
