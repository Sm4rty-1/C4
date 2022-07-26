import { Handler } from "@netlify/functions";
import { Response } from "@netlify/functions/src/function/response";
import { Event } from "@netlify/functions/src/function/event";
import { Octokit } from "@octokit/core";
import fetch from "node-fetch";

import { Finding, FindingResponse, FindingsResponse } from "../../types/findings";

import { checkAuth } from "../util/auth-utils";
import { getContest, isContestActive } from "../util/contest-utils";
import { getSubmittedFindingsFromFolder, wardenFindingsForContest } from "../util/github-utils";

async function getFinding(
  username: string,
  contestId: number,
  issueId: number,
): Promise<Response> {
  const client = new Octokit({ auth: process.env.GITHUB_TOKEN });

  const contest = await getContest(contestId);
  const repoName = contest.findingsRepo.split("/").slice(-1)[0];

  let teamHandles = [];
  const teamUrl = `${process.env.URL}/.netlify/functions/get-team?id=${username}`;
  const teams = await fetch(teamUrl);
  if (teams.status === 200) {
    const teamsData = await teams.json();
    teamHandles = teamsData.map((team) => team.handle);
  }

  // get list of submissions, filtering for access / match
  const submission_files = (
    await getSubmittedFindingsFromFolder(client, repoName)
  ).filter((item) => {
    if (item.handle === username || teamHandles.includes(item.handle)) {
      if (item.issueNumber === issueId) {
        return item;
      }
    }
  });

  // todo: don't rely on full listing
  let finding;
  if (submission_files.length === 1) {
    const findings = (await wardenFindingsForContest(client, submission_files[0].handle, contest))
      .filter((item) => {
        if (item.issueNumber === issueId) {
          return item;
        }
      });

    if (findings.length === 1) {
      finding = findings[0];
    }
  }

  if (finding) {
    const res: FindingResponse = {
      name: submission_files[0].handle,
      finding: finding,
    };

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(res),
    };
  }

  return {
    statusCode: 500,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({error: "problem fetching finding"}),
  };
}

async function getFindings(
  username: string,
  contestId: number,
  includeTeams: boolean = true
): Promise<Response> {
  // first phase:
  // given active! contest id
  // [x] warden can see own findings
  // [x] warden can see team findings
  // [ ] can see specific finding
  // [ ] team findings optional? (query param)

  const contest = await getContest(contestId);

  if (!isContestActive(contest)) {
    // throw?
  }

  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

  const wardenFindings: Finding[] = await wardenFindingsForContest(
    octokit,
    username,
    contest
  );

  const res: FindingsResponse = {
    user: wardenFindings,
    teams: {},
  };

  if (includeTeams) {
    // todo: move to util?
    let teamHandles = [];
    try {
      const teamUrl = `${process.env.URL}/.netlify/functions/get-team?id=${username}`;
      const teams = await fetch(teamUrl);
      if (teams.status === 200) {
        const teamsData = await teams.json();
        teamHandles = teamsData.map((team) => team.handle);
      }
    } catch (error) {
      return {
        statusCode: error.status || 500,
        body: JSON.stringify({ error: error.message || error }),
      };
    }

    for (const teamHandle of teamHandles) {
      const teamFindings: Finding[] = await wardenFindingsForContest(
        octokit,
        teamHandle,
        contest
      );
      res.teams[teamHandle] = teamFindings;
    }
  }

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(res),
  };
}

interface FindingEditRequest {
  issue: number;
  contest: number;
  emailAddresses?: string[];
  attributedTo?: {
    newValue: string;
    oldValue: string;
    wallet: string;
  };
  risk?: {
    newValue: string;
    oldValue: string;
  };
  title?: string;
  body?: string;
}

async function editFinding(
  username: string,
  contestId: number,
  issueNumber: number,
  data: FindingEditRequest,
): Promise<Response> {
  // an authenticated warden can edit a finding
  //   for active contests
  //     their own (their teams')
  let edited = false;

  /*
  {
    "issue": 70,
    "contest": 999999,
    "emailAddresses": ["dzhawsh@code4rena.com"],
    
    "attributedTo"?: {oldValue, newValue, wallet},
    // or maybe just include with attributedTo?
       "address"?: newValue, // only if attributedTo changes
    "risk"?: {oldValue, newValue},
    "title"?: "QA Report",
    "body"?: (combined with links to code on client-side),
  }
  */

  // get contest to find repo
  const contest = await getContest(contestId);

  // modifications to issueid

  // check for authorization to edit --
  // the issue is warden or team

  // did attribution change?
  if (data.attributedTo) {
    // read issue-json
    // change "address" value to data.wallet
    // write/rename issue-json
    edited = true;
  }

  // did risk change?
  if (data.risk) {
    // these are GitHub-named already?
    // remove label corresponding to data.risk.oldValue
    // add label corresponding to data.risk.newValue
    edited = true;
  }

  // simple field updates

  // did title change?
  if (data.title) {
    edited = true;
  }

  // did body change?
  if (data.body) {
    edited = true;
  }

  if (edited) {
    // apply edited-by-warden label
    // add GH comment for "edited by" ${C4-User}
    // send e-mails
  }

  return {
    statusCode: 500,
    body: JSON.stringify({error: "something went wrong editing submision"}),
  };
}

const handler: Handler = async (event: Event): Promise<Response> => {
  // todo: error handling..

  if (!(await checkAuth(event))) {
    return {
      statusCode: 401,
      body: JSON.stringify({
        error: "Unauthorized",
      }),
    };
  }

  // simple param filling
  let username;
  if (event.headers["c4-user"]) {
    username = event.headers["c4-user"];
  }

  let contestId;
  if (event.queryStringParameters?.contest) {
    contestId = parseInt(event.queryStringParameters?.contest);
  }

  let issueNumber;
  if (event.queryStringParameters?.issue) {
    issueNumber = parseInt(event.queryStringParameters?.issue);
  }

  switch (event.httpMethod) {
    case "GET":
      let includeTeams = true;
      // if (req.queryStringParameters?.includeTeams) {
        // includeTeams = req.queryStringParameters?.includeTeams)
      // }

      if (issueNumber !== undefined) {
        return await getFinding(username, contestId, issueNumber);
      }
      else {
        return await getFindings(username, contestId, includeTeams);
      }
    case "POST":
      return await editFinding(username, contestId, issueNumber, JSON.parse(event.body!));
    default:
      return {
        statusCode: 418,
        body: JSON.stringify({
          error: "nuh-uh",
        }),
      };
  }
};

export { handler };
