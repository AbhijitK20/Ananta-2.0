# 02 — Engine Internals: algorithm & data-structure extraction

Scope: 7 repos, read-only. Every claim is tagged `repo/path:line`. Snippets are verbatim.
"NOT PRESENT IN CODE" is used where a documented capability has no implementation.

Repo roots (absolute):
- `/home/abhijitk20/Travel_buddy/research/systems/itinera/`
- `/home/abhijitk20/Travel_buddy/research/systems/tripweaver/`
- `/home/abhijitk20/Travel_buddy/research/patterns/pyvrp/`
- `/home/abhijitk20/Travel_buddy/research/peer/floattrip/`
- `/home/abhijitk20/Travel_buddy/research/peer/routemind/`
- `/home/abhijitk20/Travel_buddy/research/systems/routemind-pritesh/`  (NOT the path given in the brief — see §7.0)
- `/home/abhijitk20/Travel_buddy/research/systems/uguiderag/`

---

## 1. ITINERA request decomposition

### 1.1 The three axes are NOT three orthogonal axes

The brief describes three axes: *granularity* (POI-level vs itinerary-level), *specificity* (named vs vague), *attitude* (want vs avoid). What the code actually implements is a **4-field record per request**, where granularity and specificity are two separate fields and attitude is split into two:

| paper axis | code field | type | values |
|---|---|---|---|
| granularity | `type` | enum | `"location"` \| `"itinerary"` \| `"starting point"` \| `"ending point"` |
| specificity | `mustsee` | bool | `true` = specific named place, `false` = generic category |
| attitude (want) | `pos` | string | free text, must contain no negation |
| attitude (avoid) | `neg` | string \| null | free text, negation target extracted *out* of `pos` |

**There is no dataclass.** The record is a raw `dict` parsed straight out of `json.loads`, and the field names are hard-coded string literals in `parse_user_input`.

The Chinese variant (`itinera.py`) uses the same four field names but Chinese `type` values: `地点 / 行程 / 起点 / 终点`.

### 1.2 The literal field names and enum values

`systems/itinera/model/itinera_en.py:174-210` — the English consumer:

```python
    def parse_user_input(self, structured_input):
        must_see_poi_names = []
        itinerary_pos_reqs, itinerary_neg_reqs = [], []
        user_pos_reqs, user_neg_reqs = [], []
        start_poi, end_poi = None, None

        for req in structured_input:
            # Default the type to "location" if not specified
            if req["type"] is None:
                req["type"] = "location"

            # Handle "itinerary" type requirements
            if req["type"] == "itinerary":
                itinerary_pos_reqs.append(req["pos"])
                if req["neg"] is not None:
                    itinerary_neg_reqs.append(req["neg"])

            # Handle location-related types: "location", "starting point", "ending point"
            elif req["type"] in ["location", "starting point", "ending point"]:
                if req["mustsee"] == True:
                    must_see_poi_names.append(req["pos"])
                user_pos_reqs.append(req["pos"])
                user_neg_reqs.append(req["neg"])
                if req["type"] == "starting point":
                    start_poi = req["pos"]
                if req["type"] == "ending point":
                    end_poi = req["pos"]
            else:
                # Raise an error if an unexpected type is encountered
                raise ValueError("Unexpected type encountered in user input.")

        # If no specific positive user requirements, use itinerary positive requirements
        if len(user_pos_reqs) == 0:
            user_pos_reqs = itinerary_pos_reqs

        return must_see_poi_names, itinerary_pos_reqs, itinerary_neg_reqs, user_pos_reqs, user_neg_reqs, start_poi, end_poi
```

`systems/itinera/model/itinera.py:177-199` — the Chinese consumer, same structure:

```python
        for req in structured_input:
            if req["type"] is None:
                req["type"] = "地点"
            if req["type"] == "行程":
                itinerary_pos_reqs.append(req["pos"])
                if req["neg"] != None:
                    itinerary_neg_reqs.append(req["neg"])

            elif req["type"] in ["地点", "起点", "终点"]:
                if req["mustsee"] == True:
                    must_see_poi_names.append(req["pos"])
```

Note the output contract: a **7-tuple**, not an object. `must_see_poi_names` (strings) are *never* in the embedding query; they are fuzzy-matched to row ids separately (§1.5).

### 1.3 How a free-text query is mapped onto the axes: **LLM only, no rules**

`systems/itinera/model/itinera.py:154-169` — one GPT-4o call, no fallback logic beyond a regex for a `[...]` block:

```python
    def parse_user_request(self, user_reqs):
        """Fetch and parse user response from the proxy."""
        response = self.proxy.chat(messages=[{"role": "user", "content": process_input_prompt(user_input=user_reqs)}], model=self.MODEL).replace("'", '"')
        try:
            return json.loads(response)
        except:
            match = re.search(r'\[(.*?)\]', response, re.DOTALL)
            if match:
                json_str = match.group(0)
                try:
                    return json.loads(json_str)
                except json.JSONDecodeError:
                    print("Found string is not a valid JSON.")
            else:
                print("No JSON found in the string.")
            return {}
```

- model = `"gpt-4o"` (`itinera.py:23`), temperature default 0 (`utils/proxy_call.py:12`).
- `response_format={"type": "json_object"}` is **commented out** (`utils/proxy_call.py:15`) — so there is no structured-output enforcement; robustness comes from `json.loads` → regex `[...]` → `{}`.
- The only "rules" are downstream in `parse_user_input`: (a) `type is None -> "location"`, (b) unknown `type` -> `raise ValueError`, (c) empty `user_pos_reqs` falls back to `itinerary_pos_reqs`.

A second, separate LLM call extracts the time budget — `itinera.py:146-152`:

```python
    def get_hours(self, user_reqs, hours):
        """Get the number of hours for the plan; fetch from proxy if not provided."""
        if hours == 0:
            msg = [{"role": "user", "content": get_hour_prompt(user_reqs=user_reqs)}]
            response = self.proxy.chat(messages=msg, model=self.MODEL).replace("'", '"')
            hours = int(json.loads(response)[0])
        return hours
```

### 1.4 The decomposition prompt template (the actual schema the LLM is given)

`systems/itinera/model/utils/all_en_prompts.py:133-266` (`process_input_prompt`). The schema is defined by a Python literal inside the prompt, and the enum is *stated three times* (format block, output-spec block, notes block).

`all_en_prompts.py:142-146`:
```
    Return a list where each item is a dictionary representing an independent requirement, with the following key-value pairs:
    - **pos**: Positive requirement, representing what the user wants, excluding any negative requirements.
    - **neg**: Negative requirement, usually representing what the user does not want or wants to avoid; all negative aspects should be extracted into this field. For example, "not spicy" should extract "spicy," "don't want crowded" should extract "crowded," and "dislikes noisy places" should extract "noisy."
    - **mustsee**: Indicates whether this requirement represents a specific location name. If it does, this field is `true`; otherwise, it is `false`.
    - **type**: Indicates whether the requirement is for a "location" or the "itinerary," with the values "location," "starting point," "ending point," or "itinerary."
```

The `mustsee` heuristic is spelled out as a lexical rule at `all_en_prompts.py:225-227`:
```
    ### mustsee Field Assignment Examples
    "mustsee" is true for specific location names: "Hualian Mall," "Old Mac Cafe," "Wukang Mansion," "Nanluoguxiang", ...
    "mustsee" is false for generic location names: "mall," "tea shop," "bar," "coffee," ...
```

Hard cardinality constraints in the prompt (`all_en_prompts.py:163-164`):
```
    - If a location is specifically a "starting point" or "ending point," then the "type" field should be "starting point" or "ending point"; starting and ending points are required points, so "mustsee" should be set to true.
    - A location can only be a specific landmark or location to qualify as a "starting point" or "ending point"; you can only return at most one "starting point" and one "ending point."
```

Splitting compound landmarks into separate requests (`all_en_prompts.py:259`):
```
    All landmarks must be fully separated; for example, "Nanluoguxiang and Drum Tower" must be split into the two separate requirements "Nanluoguxiang" and "Drum Tower."
```

### 1.5 Re-merging decomposed requests into a candidate set

Two-stage: **score accumulation over embedding retrieval, then score-injection, then cluster-level selection.**

**Stage A — per-request top-k, then sum scores per POI** (`itinera.py:200-243`):

```python
    def get_reqs_topk(self):
        def process_request(user_pos_req, user_neg_req):
            # Limit top-k to the minimum of available POIs or the defined candidate number
            top_k = min(self.user_favorites.shape[0], self.min_poi_candidate_num)
            req_pois = self.search_engine.query(desc=(user_pos_req, user_neg_req), top_k=top_k)

            # Collect top two POIs as pseudo-must-see if not already present
            pseudo_must_see_local = [int(poi) for poi in req_pois[:2, 0] if poi not in pseudo_must_see_pois]
            return req_pois, pseudo_must_see_local
        ...
        # Concatenate results and aggregate scores for unique POIs
        all_reqs_topk = np.concatenate(all_reqs_topk, axis=0)
        unique_values = np.unique(all_reqs_topk[:, 0])
        result = [[value, all_reqs_topk[all_reqs_topk[:, 0] == value][:, 1].sum()] for value in unique_values]
        result = np.array(result)
        # Sort by score in descending order
        sorted_reqs_topk = result[result[:, 1].argsort()[::-1]]
        return sorted_reqs_topk, pseudo_must_see_pois
```

Re-merge rule: **a POI's score is the plain SUM of its cosine similarities across all decomposed requests.** No normalisation by request count, no max, no reciprocal-rank fusion. Requests are processed in a `ThreadPoolExecutor` (`itinera.py:221-224`).

**"Pseudo must-see" invention** — the top-2 POIs of *every* request are promoted to must-see status even if the user never named them (`itinera.py:214`). This is a good trick: it guarantees spatial coverage of the query without a hard constraint.

**Negation handling = score subtraction, then mean re-centring** (`model/search.py:97-121`):

```python
        if neg_desc not in [None, ""]:
            ...
            neg_indices, neg_similarities = self.top_k_cosine_similarity(neg_embedding, self.embedding, k=100000000, indices=indices)
            ...
            mean_similarity = np.mean(similarities)

            for i in range(len(neg_similarities)):
                similarities[i] -= neg_similarities[i]
            similarities += (mean_similarity - np.mean(similarities)) # back to original similarities.
```

This is a *vector* subtraction over the FULL ranking, then a single global shift to restore the original mean. It is a crude "avoid" operator, not a hard filter. `indices=indices` masks out everything not in the positive top-100000000 (i.e. everything) — effectively a no-op guard.

**Score injection for must-see** — magic numbers `1000` (must-see) and `10` (pseudo-must-see), set *before* cluster selection (`model/spatial.py:230-242`):

```python
        for poi in pseudo_must_see_pois:
            if poi not in cur_ids:
                req_topk_pois = np.insert(req_topk_pois, 0, np.array([poi, 10]), axis=0)
            else:
                row_idx = cur_ids.tolist().index(poi)
                req_topk_pois[row_idx, 1] = 10

        for poi in must_see_poi_idlist:
            if poi not in cur_ids:
                req_topk_pois = np.insert(req_topk_pois, 0, np.array([poi, 1000]), axis=0)
            else:
                row_idx = cur_ids.tolist().index(poi)
                req_topk_pois[row_idx, 1] = 1000
```

The `900` in `sample_items` is chosen precisely to sit between 10 and 1000 so must-sees always survive downsampling (`utils/funcs.py:141`): *"We set the similarity score for the must-see points as 1000. Setting the threshold as 900 ensures we could keep those must-see points."*

**Named-entity -> row id: fuzzy match, score > 91** (`model/utils/funcs.py:10-30`):

```python
def get_user_data_embedding(city_name, must_see_poi_names, type='zh'):
    data = pd.read_csv(os.path.join("model", "data", f'{city_name}_{type}.csv'))
    embedding = np.load(os.path.join("model", "data", f'{city_name}_{type}.npy'))

    all_poi_names = data["name"].tolist()
    must_see_pois = []

    for must_see_poi_name in must_see_poi_names:
        match, score = process.extract(must_see_poi_name, all_poi_names, limit=1)[0]
        if score > 91:
            must_see_pois.append(all_poi_names.index(match))
```

(`thefuzz.process.extract`, cutoff 91.) A named place that fails the cutoff is **silently dropped** — there is no "unknown place" feedback to the user.

**Retrieval primitive** — dense cosine over a precomputed `.npy`, OpenAI `text-embedding-3-small` (`model/search.py:29-34`, `utils/proxy_call.py:31-35`):

```python
        # Normalize the vectors
        A_norm = A / np.linalg.norm(A)
        B_norm = B / np.linalg.norm(B, axis=1)[:, np.newaxis]

        # Compute the cosine similarity
        cosine_similarities = np.dot(A_norm, B_norm.T)
```

The embedding text is `name + "，地址是" + address + "，" + desc` (`search.py:68`) — note this text template is Chinese even for the English dataset.

### 1.6 What is NOT in the code

- **No dataclass / pydantic model for a decomposed request.** The schema lives only in the prompt string. `NOT PRESENT IN CODE` as a typed artefact.
- **No `want`/`avoid` boolean.** The axis is realised as a `(pos, neg)` string pair with a *rule* that `pos` must not contain negation, enforced only by prompt.
- **No rules-based mapping from free text to the axes.** 100% LLM. (The only rule-based layer is the post-hoc cardinality/aggregation.)
- **No re-query after merging.** Merging is score summation; there is no second retrieval pass conditioned on the merged set.

---

## 2. ITINERA cluster-then-route — the algorithm to copy

### 2.1 Units and data layout

`model/data/shanghai_en.csv` header: `id,name,x,y,lon,lat,context`. Sample row:
`7973,Nanjing Road Pedestrian Street,13523603.01635883,3663637.0235004686,121.48459285959999,31.237541636,...`

`x,y` are **Web Mercator (EPSG:3857) metres** (13.5M, 3.66M). `utils/funcs.py:215-237` has `convert_to_mercator()` using `EPSG:3857` for exactly this. `lon,lat` are GCJ-02 (China datum) — confirmed by `README.md:134` and the `xyconvert.gcj2wgs` call at `itinera.py:65`.

**All spatial thresholds in the code are therefore metres in EPSG:3857.**

### 2.2 The hours -> (n_clusters, n_pois, distance_thresh) table

`itinera.py:20-25` — the single most copyable artefact in the whole repo:

```python
    def __init__(self, user_reqs, min_poi_candidate_num=19, keep_prob=0.8, thresh=1000, hours=0, proxy_call=None, citywalk=True, city=None, type='zh'):
        # Initialize core parameters and constants
        self.MODEL = "gpt-4o"
        # (hours, poi_num, distance_thresh)
        self.TIME2NUM = {1: (1, 3, 2000), 2: (1, 5, 3000), 3: (2, 7, 4000), 4: (2, 9, 5000), 5: (3, 11, 6000), 6: (3, 13, 7000), 7: (4, 15, 8000), 8: (4, 17, 9000)}
```

So: 1 hour -> 1 cluster / 3 POIs / 2000 m radius; 8 hours -> 4 clusters / 17 POIs / 9000 m radius. Linear in hours. The radius is the **cluster formation diameter** (see §2.3), not a per-hop budget.

**Caveat / latent bug:** `self.thresh = 1000` (the constructor default, `itinera.py:35`) is used as the clustering threshold on the *non-citywalk* fallback path (`spatial.py:270`) and is **never scaled by `hours`**. So the "you need a vehicle" path silently uses a 1 km radius regardless of whether the trip is 1 h or 8 h. `citywalk_thresh` *is* scaled.

### 2.3 Clustering = threshold graph + repeated **maximum-clique extraction** (NOT DBSCAN, NOT k-means, NOT hierarchical)

`model/spatial.py:50-87` — verbatim:

```python
    def get_clusters(self, poi_idlist: list, thresh: int = 5000) -> list:
        """
        Identify clusters of points within a given distance threshold in a set of points.
        """
        data = self.data.loc[poi_idlist]
        coords = data[['x', 'y']].astype(float).to_numpy()

        dist_matrix = scipy.spatial.distance.cdist(coords, coords)
        np.fill_diagonal(dist_matrix, thresh + 100)
        N = len(coords)
        G = nx.Graph()
        for i in range(N):
            G.add_edge(i, i)
            for j in range(i+1, N):  # avoid duplicates and self-loops
                if dist_matrix[i, j] < thresh:
                    G.add_edge(i, j)

        all_clusters = []

        if G.number_of_edges() == 0:
            all_clusters = [[i for i in poi_idlist]]
            return all_clusters

        while G.number_of_nodes() > 0:
            cliques = list(nx.find_cliques(G))
            index_of_longest = max(enumerate(cliques), key=lambda x: len(x[1]))[0]
            biggest_cluster_list = list(set(cliques[index_of_longest]))
            G.remove_nodes_from(biggest_cluster_list)
            all_clusters.append(set(np.array(poi_idlist)[np.array(biggest_cluster_list)].tolist()))

        return all_clusters
```

Precise characterisation:
- **Metric:** `scipy.spatial.distance.cdist` default = **Euclidean on the projected (metre) x,y**. Not haversine. (Justified: at city scale, Web Mercator metres are close enough to true metres.)
- **Graph:** undirected proximity graph, edge `(i,j) <-> d(i,j) < thresh` metres. **Strict `<`.** Self-loops are manually added for *every* node (`G.add_edge(i, i)`) so no node is ever absent from `find_cliques` output; the diagonal of the distance matrix is set to `thresh + 100` so the self-distance doesn't matter.
- **Partition algorithm:** iterative **maximum-clique peeling** (`nx.find_cliques` = Bron-Kerbosch with pivoting). Each round: take the largest clique, emit it, delete its vertices, recompute. Repeat until the graph is empty.
- **Consequence:** clusters are cliques, therefore every intra-cluster pair is within `thresh` — i.e. **cluster diameter <= thresh**. This is a *diameter*-bounded partition, not a centroid-radius partition. Chain-like POI sets get split rather than chained together.
- **Tie-breaking:** `max(enumerate(cliques), key=len)` takes the *first* maximum in `find_cliques` order — deterministic for a given input but not semantically meaningful.
- **Complexity:** `nx.find_cliques` is exponential in the worst case. Fine here because input is a top-k candidate set (~19-40 POIs), not the whole city.
- **Degenerate case:** if the graph has no edges, everything collapses into one cluster (note this returns a `list` of ids, whereas the normal return is a `list` of `set`s — a type inconsistency, `spatial.py:77` vs `:85`).

### 2.4 Outlier pruning: 1.5-sigma around the *global* centroid

`model/spatial.py:24-48` — verbatim:

```python
    def remove_outliers(self, poi_candidates: list, selected_clusters: list):
        # Fetch the coordinates of the POI candidates
        coordinates = self.data.loc[poi_candidates, ["x", "y"]].astype('float').to_numpy()

        # Calculate the centroid of all coordinates
        centroid = np.mean(coordinates, axis=0)

        # Calculate the distances of each point to the centroid
        distances = np.linalg.norm(coordinates - centroid, axis=1)

        # Calculate mean and standard deviation of the distances
        mean_distance = np.mean(distances)
        std_distance = np.std(distances)

        # Filter out outliers based on distance
        non_outliers = [poi for i, poi in enumerate(poi_candidates) if abs(distances[i] - mean_distance) <= 1.5 * std_distance]

        # Update clusters to remove outlier POIs
        filtered_clusters = []
        for cluster in selected_clusters:
            filtered_cluster = [poi for poi in cluster if poi in non_outliers]
            if filtered_cluster:
                filtered_clusters.append(filtered_cluster)

        return non_outliers, filtered_clusters
```

A textbook 1.5-sigma filter on radial distance to the candidate-set centroid. Applied only on the *non-citywalk* path (`spatial.py:309`).

### 2.5 Candidate selection: greedy cluster harvesting with a score-sum ranking + a pure cluster/hit-count target

`model/spatial.py:210-322`. Key parts verbatim.

**(a) Two paths — "can this be a pure walking trip?"** (`spatial.py:244-270`):

```python
        if self.citywalk:
            clusters = self.get_clusters(allpoi_idlist, thresh=self.citywalk_thresh)
            index_candidates = get_top_k_sets(clusters, req_topk_pois, k=min(len(clusters), 2))
            index = np.random.choice(index_candidates, size=1)[0]
            selected_cluster = []

            for poi in clusters[index]:
                if poi not in poi_candidates:
                    selected_cluster.append(poi)
                    poi_candidates.append(poi)

            for poi in must_see_poi_idlist:
                if poi not in selected_cluster or len(poi_candidates) < self.min_pois - 2:
                    mark_citywalk = False
                    break

            for poi in pseudo_must_see_pois:
                if poi not in selected_cluster or len(poi_candidates) < self.min_pois - 2:
                    mark_citywalk = False
                    break

            if len(selected_cluster) > 0 and mark_citywalk:
                selected_clusters.append(selected_cluster)

        if not mark_citywalk or not self.citywalk or len(poi_candidates) < 10:
            poi_candidates, selected_clusters = [], []
            clusters = self.get_clusters(allpoi_idlist, thresh=thresh)
```

`mark_citywalk` is the "walking feasibility" flag: it is `True` only if **one** clique contains *every* must-see and pseudo-must-see POI and already has >= `min_pois - 2` members. It is a side-effecting instance attribute set by this method and read later at `itinera.py:123` and `itinera.py:481`; the LLM is told about it (`all_en_prompts.py:283-286`: `times = 2` if citywalk else 1 — a hint multiplier in the narration prompt).

**(b) The harvest loop on the general path** (`spatial.py:271-309`):

```python
            # The following code guarantees the inclusion of all user-requested POIs in the candidate set.
            merge_must_see_poi_idlist = []
            merge_must_see_poi_idlist.extend(must_see_poi_idlist)

            if pseudo_must_see_pois is not None:
                merge_must_see_poi_idlist.extend(pseudo_must_see_pois)

            merge_must_see_poi_idlist = list(set(merge_must_see_poi_idlist))
            idx = find_clusters_containing_all_elements(clusters, merge_must_see_poi_idlist)

            for index in idx:
                selected_cluster = []
                for poi in clusters[index]:
                    if poi not in poi_candidates:
                        selected_cluster.append(poi)
                        poi_candidates.append(poi)
                if len(selected_cluster) > 0:
                    selected_clusters.append(selected_cluster)

            if len(idx) <= self.min_clusters or len(poi_candidates) < min(min_num_candidate, self.data.shape[0]):
                while True: # this loop will end if <<< len(poi_candidates) > min_num_candidate >>> or <<< no remaining candidates in clusters >>>
                    index_candidates = get_top_k_sets(clusters, req_topk_pois, k=min(len(clusters), 2))

                    if len(index_candidates) == 0 or (len(selected_clusters) > self.min_clusters and len(poi_candidates) >= min(min_num_candidate, self.data.shape[0])):
                        break

                    index = np.random.choice(index_candidates, size=1)[0] # this introduces some randomness
                    selected_cluster = []
                    for poi in clusters[index]:
                        if poi not in poi_candidates:
                            selected_cluster.append(poi)
                            poi_candidates.append(poi)

                    if len(selected_cluster) > 0:
                        selected_clusters.append(selected_cluster)

                    clusters.pop(index)

            poi_candidates, selected_clusters = self.remove_outliers(poi_candidates, selected_clusters)
```

- `find_clusters_containing_all_elements(clusters, must_see_ids)` returns the index of **any** cluster containing **at least one** of the must-see ids — despite its name and docstring saying "all" (`utils/funcs.py:321-340`, note the `break` after the first hit). So it is really "clusters touching the must-see set".
- The harvest target is **two counters**: `len(selected_clusters) > self.min_clusters` AND `len(poi_candidates) >= min_num_candidate`.
- **Stochastic:** `np.random.choice(index_candidates, size=1)` picks uniformly from the top-`min(len(clusters),2)` clusters by summed score. This is the only source of diversity, and it makes the pipeline **non-deterministic**. There is no seed anywhere in the repo.

**The cluster scoring function** (`utils/funcs.py:266-291`) — sum of member scores, descending:

```python
def get_top_k_sets(A: list, B: np.ndarray, k: int = 2) -> list:
    # Create a dictionary to store the sum of values for each set in A
    set_sums = {}
    for idx, set_elem in enumerate(A):
        total_value = 0
        for item in set_elem:
            corresponding_value = B[np.where(B[:, 0] == item)][0, 1]
            total_value += corresponding_value
        set_sums[idx] = total_value

    # Sort the dictionary based on the sum of values and get the top k keys
    top_k_sets = sorted(set_sums, key=set_sums.get, reverse=True)[:k]
    return top_k_sets
```

k is capped at **2** everywhere (`spatial.py:246`, `:292`) — i.e. "pick randomly between the best cluster and the second-best cluster".

**(c) Score down-sampling** (`itinera.py:267-270` -> `utils/funcs.py:120-174`). If the candidate set overshoots `min_poi_candidate_num`, keep everything with score > 900 (or in `keep_ids`), then sample the rest with probability proportional to normalised score:

```python
    # Split items based on threshold
    keep_indices = [i for i, score in enumerate(B) if score > threshold or A[i] in keep_ids]
    remaining_indices = [i for i in range(len(B)) if i not in keep_indices]

    # If remaining scores are all zero, sample uniformly
    remaining_scores = np.array([B[i] for i in remaining_indices])
    if np.sum(remaining_scores) == 0:
        sample_size = int(len(remaining_indices) * keep_prob)
        sampled_indices = np.random.choice(remaining_indices, size=sample_size, replace=False)
    else:
        # Normalize the scores of the remaining items
        normalized_scores = remaining_scores / np.sum(remaining_scores)
        # Sample based on normalized scores
        sampled_indices = np.random.choice(remaining_indices, size=int(len(remaining_indices) * keep_prob), p=normalized_scores, replace=False)
```

### 2.6 Routing: cluster TSP -> per-cluster TSP -> inter-cluster bridge POIs

**Step 1 — order the clusters by TSP on centroids** (`model/spatial.py:144-168` + `itinera.py:283-297`):

```python
        if locs is None:
            locs = self.data.loc[poi_candidates_list, ["x", "y"]].astype(float).to_numpy()
        dist_matrix = scipy.spatial.distance.cdist(locs, locs)
        if locs.shape[0] > 2:
            order, distance = solve_tsp_simulated_annealing(dist_matrix)
        elif locs.shape[0] == 2:
            order = [0, 1]
        else:
            order = [0]
```

So the cluster-level routing is **`python_tsp.heuristics.solve_tsp_simulated_annealing`** on the Euclidean centroid distance matrix. <=2 clusters -> trivial order.

```python
        clusterCentroids = self.spatial_handler.get_cluster_centroids(selected_cluster)
        clusters_order, _, _ = self.spatial_handler.get_tsp_order(locs=np.array(clusterCentroids))

        newclusters_order = []
        recurring_order = [i for i in clusters_order]
        recurring_order.append(recurring_order[0])
        distances = compute_consecutive_distances(np.array(clusterCentroids), recurring_order)
        topmax_distance_ids = distances.argsort()[-1:][::-1][0] # k=1
        newclusters_order.extend(clusters_order[topmax_distance_ids+1:])
        newclusters_order.extend(clusters_order[:topmax_distance_ids+1])
        clusters_order = newclusters_order
```

**Step 2 — rotate the cluster order to open the tour at its "heaviest" edge.** Find the largest centroid-to-centroid gap in the closed tour and rotate the order so that edge becomes the wrap-around (open-path) edge. A cheap, sensible 2-opt-open move.

**Step 3 — pick the bridging POI pair between consecutive clusters** (`model/spatial.py:188-208`):

```python
        all_pairs = []
        for i in range(len(clusters_order)-1):
            locsCluster1, locsCluster2 = self.data.loc[clusters[clusters_order[i]]][["x", "y"]].astype(float).to_numpy(), self.data.loc[clusters[clusters_order[i+1]]][["x", "y"]].astype(float).to_numpy()
            pair = get_topk_location_pairs(locsCluster1, locsCluster2, k=min(3, locsCluster1.shape[0], locsCluster2.shape[0]))
            pair = [clusters[clusters_order[i]][pair[0][0]], clusters[clusters_order[i+1]][pair[0][1]]]
            all_pairs.append(pair)
```

`get_topk_location_pairs` (`utils/funcs.py:294-317`) computes the full cross product of Euclidean distances and takes the `k` smallest via `np.argpartition`, then **uses only `pair[0]`** (the global nearest pair). So: consecutive clusters are stitched at their closest POI pair.

**Step 4 — within a cluster, exact MILP TSP with fixed start/end** (`model/spatial.py:89-142`). This exact-LP version is used only for **interior** clusters (the first and last cluster are handled separately at `itinera.py:386-435` and `:437-444`):

```python
        n = len(dist_matrix)
        dist = {(i, j): dist_matrix[i][j] for i in range(n) for j in range(n) if i != j}
        prob = LpProblem("TSP", LpMinimize)
        x = LpVariable.dicts('x', dist, 0, 1, LpBinary)
        prob += lpSum([x[(i, j)] * dist[(i, j)] for (i, j) in x])

        for k in range(n):
            if k == start_point:
                prob += lpSum([x[(k, i)] for i in range(n) if i != k]) == 1
                prob += lpSum([x[(i, k)] for i in range(n) if i != k]) == 0
            elif k == end_point:
                prob += lpSum([x[(k, i)] for i in range(n) if i != k]) == 0
                prob += lpSum([x[(i, k)] for i in range(n) if i != k]) == 1
            else:
                prob += lpSum([x[(k, i)] for i in range(n) if i != k]) == 1
                prob += lpSum([x[(i, k)] for i in range(n) if i != k]) == 1

        while True:
            prob.solve(PULP_CBC_CMD(msg=0))
            edges = [(i, j) for (i, j) in x if value(x[(i, j)]) > 0.5]
            G = nx.Graph()
            G.add_edges_from(edges)
            subtours = [c for c in nx.connected_components(G) if len(c) < n]
            if not subtours:
                break
            for s in subtours:
                prob += lpSum([x[(i, j)] for (i, j) in permutations(s, 2)]) <= len(s) - 1
```

PuLP + CBC, binary `x[i][j]`, iterative subtour elimination by connected-component detection, `permutations(s,2)` for the SEC constraint. This is the "right" way to do open-TSP-with-fixed-endpoints exactly, in ~25 lines. Directly portable to TS as Held-Karp (n is tiny: cluster sizes are POIs-per-hour-buckets, typically 2-9).

**Step 5 — first cluster: pick start point + direction** (`itinera.py:406-435`). The start is either the single-cluster case (top-1 or top-2 longest tour edge, both orientations — `itinera.py:396-405`) or the POI that bridges in from the previous cluster. Note the ordering logic is inconsistent between branches: for the first cluster, `plan_candidates`/`possible_ori` are built but the LLM prompt is built and discarded at `itinera.py:320-328` — **`plan_candidates` is never used; `id2content[0]` is always taken** (`itinera.py:425`). Dead code.

**Step 6 — last cluster: rotate so it starts at the incoming bridge POI** (`itinera.py:437-444`):

```python
            elif i == len(clusters_order)-1:
                order_within_cluster, _, _ = self.spatial_handler.get_tsp_order(cluster)
                ordered_pois_within_cluster = np.array(cluster)[order_within_cluster]
                start_poi = all_pairs[i-1][1]
                idx = find_indices(ordered_pois_within_cluster, start_poi)

                new_numerical_order.extend(ordered_pois_within_cluster[idx:])
                new_numerical_order.extend(ordered_pois_within_cluster[:idx])
```

Pure cyclic rotation of the SA-TSP order — no re-solve, which can leave a long intra-cluster jump.

**Step 7 — re-flatten and de-duplicate** (`itinera.py:473`): `remove_duplicates(new_numerical_order)` — order-preserving, O(n^2) (`utils/funcs.py:200-205`).

### 2.7 The LLM's role in routing: start point + a full/half reversal test

Two LLM calls touch the route, both in `calculate_ordered_route_info` (`itinera.py:302-373`):

1. **Open-tour start** — only if the user *did not* name a start POI (`itinera.py:320-333`):
```python
        if self.start_poi is not None and self.start_poi in new_numerical_ordered_poiname:
            response = [new_numerical_ordered_poiname.index(self.start_poi)]
        else:
            msg = [{"role": "user", "content": get_start_point_prompt(candidate_points=new_numerical_ordered_poiname, user_reqs=self.user_reqs, return_candidates=return_candidates, distance_string=distance_string)}]
            response = self.proxy.chat(messages=msg, model=self.MODEL).replace("'", '"')
            try:
                response = json.loads(response)
            except:
                response = ["0"]
        newnew_numerical_order = []
        newnew_numerical_order.extend(new_numerical_order[int(response[0]):])
        newnew_numerical_order.extend(new_numerical_order[:int(response[0])])
```
Output is an index `k` -> **rotate** the sequence. Note `distance_string` is computed and passed but the prompt (`all_en_prompts.py:86-130`) never interpolates `{distance_string}` — dead input.

2. **Direction reversal** (`itinera.py:350-362`) — ask the LLM whether bars are mostly in the first or second half, reverse the whole sequence if the answer is `"0"`:
```python
        msg = [{"role": "user", "content": check_final_reverse_prompt(context=context_string, user_reqs=self.user_reqs)}]
        response = self.proxy.chat(messages=msg, model=self.MODEL).replace("'", '"')
        ...
        if int(response[0]) == 0:
            new_numerical_order.reverse()
```
Only the first 100 chars of each POI's `context` are shown, truncated (`itinera.py:347`).

3. **Final selection** — the LLM picks a *subset* of the ordered candidates, constrained to ascending order (`itinera.py:328`, `:342`, `:386`): `- **Point Selection**: Must follow the provided sequence order of points`. So the optimiser produces the *order*, the LLM does the *selection and narration*, and it is forbidden from reordering.

### 2.8 Verdict for ATHITI

Copy: the `TIME2NUM` table, maximum-clique-peel clustering, the sum-score cluster ranking with k=2 stochastic choice, the closest-pair cluster stitching, the heaviest-edge rotation, the "one clique must contain all must-sees" citywalk test, and the score-injection constants (1000/900/10). Do **not** copy: the PuLP exact TSP (a Held-Karp or Or-opt is 5 lines of TS and faster at these n), the `find_clusters_containing_all_elements` misnomer, the unscaled 1000 m fallback threshold, the two dead code paths, or the non-determinism.

---

## 3. TripWeaver's Z3 encoding (`z3_temporal_scheduler_with_relaxation.py`, 888 lines)

### 3.1 The relaxation mechanism — the definitive answer

**There is NO unsat-core-driven, assumption-based relaxation in the temporal scheduler.** `unsat_core()` is *called* at line 684 but the `Optimize` object has **no tracked assumptions** — every constraint goes in via bare `opt.add(...)`; `assert_and_track` is never used in this file. Z3's `unsat_core()` on an untacked solver returns an empty set. The print is a no-op.

Grep evidence (whole repo, pattern `unsat|assumption|relax|track_unsat`):
- `z3_temporal_scheduler_with_relaxation.py:684` — `print(opt.unsat_core())` — the **only** occurrence of `unsat_core` in the file; no `assert_and_track` anywhere in it.
- `z3_temporal_scheduler.py:677` — same call, same situation.
- `prompts/solve_{3,5,7}.txt:10-16 / 11-17 / 11-17` — `c = s.unsat_core()` in the *LLM-generated* code path. **Here it is meaningful**, because the prompt templates in `prompts/step_to_code_*.txt` *do* use `s.assert_and_track(constraint, 'label')`. That is a different file path (`run_planner.py`), not the temporal scheduler.
- `assert_and_track` / `assumption` / `set(unsat_core=True)`: **NOT PRESENT IN CODE** in `z3_temporal_scheduler_with_relaxation.py`.

**So what "relaxation" actually means:** exactly **two** hard constraints from `z3_temporal_scheduler.py` were demoted to soft penalty variables, and a `minimize` objective was added. The complete diff between the two files (verified with `diff`) touches nothing else algorithmically:

| strict version (`z3_temporal_scheduler.py`) | relaxed version (`..._with_relaxation.py`) |
|---|---|
| `opt.add(s_start >= preferred_start_time)` (L334-336) | `early_start_penalty >= 0; early_start_penalty >= preffered_start_time - s_start` (L337-338) |
| `opt.add(actual_sleep_duration >= preferred_sleep)` (L367) | `short_sleep_penalty >= 0; short_sleep_penalty >= preffered_sleep - actual_speep_duration` (L372-373) |
| — | `opt.minimize(Sum(early_start_penalties + short_sleep_penalties))` (L405-406) |
| — | `opt.add(e_end >= s_end)` added (L365) |

There is **no loop, no re-solve, no escalation ladder, no drop-the-weakest-constraint**. The file name is an overstatement: it is a *soft-constraint* variant, hand-written, not an automatic relaxation procedure.

### 3.2 Every penalty variable

There are exactly **two**. Both are non-negative integers with a one-sided lower bound; both are minimised. They are **not** `add_soft` constraints — they are hand-rolled epigraph variables.

`z3_temporal_scheduler_with_relaxation.py:330-340` — **early start penalty** (leaving the accommodation before the preferred 06:00):

```python
            s_start = Int(f"s_accommodation_start_{d}")
            e_start = Int(f"e_accommodation_start_{d}")
            prev_e_end = Int(f"e_accommodation_end_{d-1}")

            preffered_start_time = day_offset + windows["accommodation_start_of_day"][0]
            early_start_penalty = Int(f"early_start_penalty_{d}")

            opt.add(early_start_penalty >= 0)
            opt.add(early_start_penalty >= preffered_start_time - s_start)
            early_start_penalties.append(early_start_penalty)
```

`z3_temporal_scheduler_with_relaxation.py:365-374` — **short sleep penalty** (night block shorter than 8 h):

```python
            opt.add(e_end >= s_end)

            #short sleep penalty system
            actual_speep_duration = e_end - s_end
            preffered_sleep = durations["accommodation_end_of_day"]

            short_sleep_penalty = Int(f"short_sleep_penalty_{d}")
            opt.add(short_sleep_penalty >= 0)
            opt.add(short_sleep_penalty >= preffered_sleep - actual_speep_duration)
            short_sleep_penalties.append(short_sleep_penalty)
```

Note these are **unbounded-above** `Int`s with only a lower bound. Nothing caps them, so the solver can set them arbitrarily high and the `minimize` objective is what forces them to their true minimum. Standard ">= epigraph" idiom, and correct — but it means `minimize` is load-bearing: drop it and the penalties become free variables.

### 3.3 The objectives (three separate `minimize`/`maximize` calls on one `Optimize`)

| # | Line | Call | Meaning |
|---|---|---|---|
| 1 | `L405-406` | `opt.minimize(Sum(early_start_penalties + short_sleep_penalties))` | total discomfort in minutes |
| 2 | `L501-502` | `opt.maximize(meal_score)` | maximise number of meals taken |
| 3 | `L584-590` | `opt.maximize(attr_score)` | maximise number of attractions taken |

```python
    #---Objective: Maximize number of meals taken---
    meal_score = Sum([meal_taken[(d, m)] for d in range(days) for m in meal_types])
    opt.maximize(meal_score)
```

```python
    # ---- Objective: maximize attractions ----
    attr_score = Sum([
        If(attr_taken[(d,k)], 1, 0)
        for d in range(days)
        for k in range(MAX_ATTR)
    ])
    opt.maximize(attr_score)
```

**This is a real modelling defect worth calling out for ATHITI:** `opt.minimize` and `opt.maximize` on the *same* `Optimize` object create **separate, lexicographically-ordered optimisation objectives** (z3py `Optimize` treats them as a lexicographic sequence; objectives added later take priority). The effective ordering is: **maximise attractions first, then maximise meals, then minimise the penalty last** — the penalty term, which is the entire point of the "relaxation", has the *lowest* priority. A schedule that serves every attraction at the cost of a 3-hour night is preferred over one that respects the sleep penalty. Neither the paper nor the README acknowledges this. **ATHITI must scalarise into a single weighted sum instead.**

### 3.4 Hard constraints, grouped by source

**Constants** (`L131-152`):
```python
DAY = 24*60
travel_buffer = 30
min_meal_gap = 4*60 + 1
self_driving_start_time = 6*60
durations = {
    "breakfast": 50, "lunch": 60, "dinner": 1*60 + 15, "attraction": 3*60 + 30,
    "accommodation_start_of_day": 30, "accommodation_check_in": 30,
    "accommodation_end_of_day": 8*60, "other": 30
}
windows = {
    "breakfast": (8*60, 10*60+30), "lunch": (12*60, 15*60+30), "dinner": (19*60, 22*60),
    "attraction": (9*60, 19*60), "accommodation_start_of_day": (6*60, 9*60),
    "accommodation_check_in": (0*60, 24*60),
}
```

**Time is a single integer minute axis**, absolute from trip start: `day_offset = d * DAY`; all `s_*`/`e_*` variables are `Int` minutes since departure.

| Group | Lines | Constraints |
|---|---|---|
| City index chain | `L224-246` | `src_city[0] == cities.index(origin)`; per-leg `src_city[d]==from_idx`, `dest_city[d]==to_idx`; non-travel days `dest_city[d]==src_city[d]`; `src_city[d+1]==dest_city[d]` |
| Transport | `L279-295` | `dep >= day_offset`, `arr >= day_offset`; **flight: `dep == day_offset+dep_time`, `arr == day_offset+arr_time` (equality — times are fixed data)**; **self-driving/taxi: `dep >= day_offset+360`, `arr == dep + duration_minutes`** |
| Accommodation start-of-day (`d != 0`) | `L341-352` | `prev_e_end <= s_start`; `e_start >= s_start+30`; **`e_start <= day_offset+540`** (must be indoors by 09:00); city-consistency via `If(s_start < transport_departure[d], src, dest)` |
| Accommodation end-of-day (`d != days-1`) | `L365-382` | `e_end >= s_end`; city == `dest_city[d]`; sleep duration now *soft* |
| Check-in (travel days) | `L393-399` | `e_check >= s_check+30`; **`s_check == transport_arrival[d] + 30`**; `s_check >= day_offset`; `e_check + 30 <= s_end` |
| Start<->end link (`d != 0 and d != days-1`) | `L402` | `e_start + travel_buffer <= s_end` |
| Meal: bracketed by accommodation | `L442-449` | `Implies(taken, s >= e_accommodation_start[d]+30)`; `Implies(taken, e+30 <= s_accommodation_end[d])` |
| Meal: forced on staying days | `L452-453` | `d % 2 == 1 -> meal_taken == True` (the "odd day = not a travel day" invariant) |
| **Meal time window** | `L456-462` | see §3.5 |
| Meal: city selection | `L465-475` | `Implies(taken, c == If(s<dep, src[d], If(s>=arr, dest[d], -1)))` and `c != -1`; non-travel day: `c == src[d]` |
| Meal: restaurant exists | `L478-479` | `Implies(taken, And(c>=0, Select(restaurants,c) > 0))` |
| **Meal: 4 h gap** | `L481-489` | for each of the 3 meal pairs, `Or(s2 >= e1+min_meal_gap, s1 >= e2+min_meal_gap)` |
| Meal: per-city inventory | `L491-498` | `Sum(taken_in_city) <= Select(restaurants, city)` |
| Attraction: bracketed + time window + city + inventory | `L534-581` | mirror of the meal block with `MAX_ATTR=1` |
| **Global pairwise no-overlap** | `L595-618` | see below |

**The global no-overlap is O(n^2) pairwise disjunctions with a mandatory 30-minute buffer** — the biggest scaling hazard in the file:

```python
    for i in range(len(intervals)):
        for j in range(i+1, len(intervals)):
            a = intervals[i]
            b = intervals[j]
            if len(a) == 2:
                s1,e1 = a
                cond1 = True
            else:
                s1,e1,cond1 = a
            if len(b) == 2:
                s2,e2 = b
                cond2 = True
            else:
                s2,e2,cond2 = b

            opt.add(Implies(
                And(cond1, cond2),
                Or(e1 + travel_buffer <= s2, e2 + travel_buffer <= s1)
            ))
```

For a 7-day trip this is roughly (7 accommodation blocks x 3) + (7x3 meals) + (7x1 attractions) + 7 transport = ~49 intervals -> **1176 pairwise clauses**, each a 3-literal disjunction. z3py does not wrap the SMT-LIB `nooverlap` global, so pairwise is the only option without a custom theory — but an ATHITI implementation should use a disjunctive ladder (O(n log n) clauses) or, better, a list scheduler, because this is exactly a unit-job scheduling problem.

### 3.5 How time windows are encoded

Consistently: **soft-conditional (only when the activity is taken), with the buffer folded into the lower bound and the duration into the upper bound.** All minute arithmetic is absolute-from-trip-start.

`L456-462` (meals):
```python
            # ---- time window ----
            opt.add(Implies(taken,
                And(
                    s >= day_offset + w_start,
                    s <= day_offset + w_end - dur,
                    e >= s + dur
                )
            ))
```

`L548-554` (attractions): identical shape with `windows["attraction"] = (9*60, 19*60)`, `durations["attraction"] = 3*60+30`.

Note the pattern `s <= day_offset + w_end - dur`: the *start* must be early enough to fit the whole duration inside the window. For breakfast that is `s <= 10:30 - 50min = 09:40`.

Contrast with the *hard* accommodation windows, which are **unconditional** (no `Implies`) because the accommodation variables only exist for `d != 0` / `d != days-1`:
- `e_start >= s_start + 30` and `e_start <= day_offset + 540` (start-of-day block ends by 09:00).
- `s_check == transport_arrival[d] + 30` — check-in is *pinned* to the flight's arrival + buffer. No slack.
- `s_start` is fully free (>= 0) and only softly penalised if before 06:00. This is the soft-constraint hole.

### 3.6 Resource "capacity" encoding — a Z3 `Array`, not a scalar

`L182-187`, `L201-206`:
```python
def attraction_z3_mapping(data, cities):
    attractions = Array('attraction', IntSort(), IntSort())
    attractions = Store(attractions, 0, 0) # initialize for initial city
    for city in data["cities"]:
        attractions = Store(attractions, cities.index(city["city"]), len(city["attractions"]))
    return attractions
```

An SMT array `city_index -> number of available items in that city`, then per-city cardinality constraints:
- `L491-498` (meals): `opt.add(Sum(taken_in_city) <= Select(restaurants, city))`
- `L573-581` (attractions): `opt.add(Sum(taken_in_city) <= Select(attractions, city))`

**This is the notable trick worth stealing conceptually:** the item *identity* is not a decision variable. Only `(which city, taken or not, when)` are variables. Item selection is then **deterministic post-hoc enumeration in `used_attraction[city_idx]` order** (`L691-692`, `L804-809`):

```python
    used_attraction = {i: 0 for i in range(len(cities))}
    used_meals = {i : 0 for i in range(len(cities))}
    ...
        for k in range(MAX_ATTR):
            if is_true(model[attr_taken[(d, k)]]):
                city_idx = model[attr_city[(d, k)]].as_long()
                attr_idx = used_attraction[city_idx]
                used_attraction[city_idx] += 1
                city_name, attr_name = attraction_lookup(city_idx, attr_idx, data)
```

i.e. *the Nth taken attraction in city C is the (N+1)-th attraction in the LLM's pre-filtered list for C.* Consequence: the model **cannot express item quality, price, category preference, or dedup**. It can only express *how many* to take and *where* and *when*. All item choice was already done upstream in `parse_text` (`L93-127`) from the LLM's free-text plan.

### 3.7 UNSAT handling

`L679-687`:
```python
    result = opt.check()
    print("Solver result:", result)

    if result != sat:
        print("Model UNSAT ❌")
        print(opt.unsat_core())
        return {}
```

Then `__main__` records it and *still writes the file* (`L870-876`):
```python
            plan = scheduler(data, days, origin)

            if plan == {}:
                unsat_indexes.append(i)

            with open(write_path, 'w', encoding='utf-8') as f:
                json.dump(plan["days"], f, indent=2 , ensure_ascii=False)
```
-> on UNSAT this raises `KeyError: 'days'` on `{}`, caught by the broad `except Exception` at `L880` and filed under `error_indexes`, **not** `unsat_indexes`. So both lists are unreliable and UNSAT plans are lost. `BASE_PATH` (`L835`) points at `output/5d/qwen_nl`, which is **not in the repo** — the script is unrunnable as shipped.

---

## 4. TripWeaver's LLM stages

### 4.1 Pipeline (readme's 8 steps, `readme.md:8-17`, mapped to real code in `run_planner.py`)

| Step | Code | Prompt file | Output |
|---|---|---|---|
| 1. Normalise query -> JSON | `run_planner.py:277-285` | `prompts/query_to_json.txt` (61 lines) | `query_json` dict |
| 2. Query -> planning steps | `run_planner.py:297-306` | `prompts/constraint_to_step_nl_v2_{3d,5d,7d}.txt` | `# `-delimited step blocks |
| 3. Step -> Python/Z3 code | `run_planner.py:316-362` | `prompts/step_to_code_*.txt` (9 files) | Python source per step |
| 4. Budget objective injection | `run_planner.py:66-72` + `:348-349` | `prompts/step_to_code_budget.txt` | appends `s.minimize(spent)` or `s.maximize(spent)` |
| 5. Concatenate + append solve loop | `run_planner.py:359-368` | + `prompts/solve_{3,5,7}.txt` | `codes/codes.txt` |
| 6. Execute | `run_planner.py:406` `exec(codes, globals(), local_vars)`; also `z3_code_execution.py:173-217` (process pool) | — | `plans/plan.txt` |
| 7. Temporal scheduling | `z3_temporal_scheduler*.py` | none (hand-written) | `plan_with_poi*.txt` |
| 8. Evaluation | `evaluation/{eval,hard_constraint,commonsense_constraint,qualitative_metrics}.py` | — | metrics |

### 4.2 Stage 1 JSON schema — the only strict schema in the pipeline

`prompts/query_to_json.txt:2-3` (enum lists are exhaustive here):
```
In the JSON, "org" denotes the departure city. "dest" denotes the destination city. "days" denotes the total number of travel days. When "days" exceeds 3, "visiting_city_number" specifies the number of cities to be covered in the destination state. "date" includes the detailed date to visit.
In addition, "local_constraint" contains four possible constraints. Possible options of "house rule" includes ["parties", "smoking", "children under 10", "pets", "visitors"]. Possible options of "cuisine" includes ["Chinese", "American", "Italian", "Mexican", "Indian", "Mediterranean", "French","Caribbean","Latin"]. Possible options of "house type" includes ["entire room", "private room", "shared room", "not shared room"]. Possible options of "transportation" includes ["no flight", "no self-driving"]. If neither are mentioned in the text, make the value to be null.
```

Shape (from the three in-prompt examples, `query_to_json.txt:9-23`):
```json
{"org": str, "dest": str, "days": int, "visiting_city_number": int,
 "date": [str], "people_number": int, "budget": int,
 "local_constraint": {"house rule": str|null, "cuisine": [str]|null,
                      "room type": str|null, "transportation": str|null}}
```

Parsed with `json.loads(...replace('```json','').replace('```',''))` (`run_planner.py:277`) — code-fence stripping only, no schema validation. Explicitly labelled as post-processing only: `# json generated for postprocess only, not used in inputs to LLMs` (`run_planner.py:276`) — **except** `query_json['days']`, which *is* used, to pick the prompt file and the indentation width (`run_planner.py:352-357`, `:364`).

### 4.3 Stage 2 output format

`prompts/constraint_to_step_nl_v2_5d.txt:78-80`:
```
Based on the examples above, give the steps for following Natural Language query. Follow the original step structures.
Note to keep the format in examples and start each line containing steps with '#'
```

Not JSON — a `#`-prefixed pseudo-natural-language plan, parsed by string surgery at `run_planner.py:314-326`:
```python
        steps = steps.split('\n\n')
        for step in steps:
            try:
                lines = step.split('# \n')[1]
            except:
                lines = step.split('#\n')[1]
            prompt = ''
            step_key = ''
            for key in step_to_code_prompts.keys():
                if key in step.split('# \n')[0]:
                    prompt = step_to_code_prompts[key]
                    step_key = key
```

The step->code mapping is **substring matching on the step's header line** against the 9 keys in `run_planner.py:253-263`:
```python
    step_to_code_prompts = {
                            'Destination cities': step_to_code_destination_cities_prompt,
                            'Departure dates': step_to_code_departure_dates_prompt,
                            'Transportation methods': step_to_code_transportation_methods_prompt,
                            'Flight information': step_to_code_flight_prompt,
                            'Driving information': step_to_code_driving_prompt,
                            'Restaurant information': step_to_code_restaurant_prompt,
                            'Attraction information': step_to_code_attraction_prompt,
                            'Accommodation information': step_to_code_accommodation_prompt,
                            'Budget': step_to_code_budget_prompt
                            }
```
If a header matches nothing, `step_key == ''` and the LLM response to a prompt-less request is silently concatenated into the program.

### 4.4 Stage 3 -> how is generated code validated?

**It isn't.** There is no AST check, no lint, no schema check, no test of the generated code. The only sanitisation is three string replacements (`run_planner.py:344-346`):
```python
            code = code.replace('```python', '')
            code = code.replace('```', '')
            code = code.replace('\_', '_')
```
plus a blind re-indentation by a hardcoded number of spaces depending on trip length (`run_planner.py:351-357`):
```python
            if step_key != 'Destination cities':
                if query_json['days'] == 3:
                    code = code.replace('\n', '\n    ')
                elif query_json['days'] == 5:
                    code = code.replace('\n', '\n            ')
                else:
                    code = code.replace('\n', '\n                ')
```
This is a pure text transform that does not understand Python blocks; it works only because the prompt templates ship a consistent `for`-loop nesting depth per trip length. The nesting is enforced by the *example code in the prompt* (`prompts/step_to_code_destination_cities.txt:9-40` shows 1/2/3-level nested city loops) and by the block delimiters the prompt asks for (`prompts/step_to_code_*.txt:43-45`):
```
    # 6. **Output code ONLY between:**
    #       ########## [TYPE] response ##########
    #       ########## [TYPE] response ends ##########
    #    **where [TYPE] matches the current step (e.g., Accommodation, Transport, Restaurant).**
```
— but nothing *parses* those delimiters either; the stripping is only ```` ``` ````.

**Execution is raw `exec`** — `run_planner.py:406`:
```python
    exec(codes, globals(), local_vars)
```
and `z3_code_execution.py:192`:
```python
        exec(code, exec_env)
```
Error handling = write a traceback to `error.txt` and continue to the next query (`run_planner.py:373-380`). Note `run_planner.py:370` is even commented out: `# exec(codes)`.

### 4.5 How the Z3 solve is invoked, and UNSAT handling

The solver object is created *by the LLM*, as `s = Optimize()` inside the "Destination cities" step template (`prompts/step_to_code_destination_cities.txt:13`), inside a triple-nested loop over city combinations. So the **search over which cities to visit is brute force in Python** (`for city_0 ... for city_1 ... for city_2`), with a fresh `Optimize()` per combination, and only the *last* `s`/`variables` survive into subsequent steps.

The solve block is appended verbatim from `prompts/solve_{3,5,7}.txt`. `solve_5.txt` in full (15 lines):
```
            if s.check() == sat:
                print('ok')
                plan = generate_as_plan(s, variables, query_json)
                with open(path+'plans/' + 'plan.txt', 'w') as f:
                    f.write(plan)
                f.close()
                success = True
                break
            else:
                print('not ok')
                c = s.unsat_core()
                print(c)
                with open(path + 'plans/unsat_info.txt', 'w') as f:
                    f.write("not ok\n")
                    f.write("Unsatisfiable core:\n")
                    for constraint in c:
                        f.write(str(constraint) + '\n')
    if success: break
```

**This IS genuine unsat-core machinery** — and it works here because the prompt-generated constraints all use `s.assert_and_track(<constraint>, '<label>')`:
- `prompts/step_to_code_budget.txt:15` — `s.assert_and_track(spent <= variables['budget_limit'], 'budget enough')`
- `prompts/step_to_code_destination_cities.txt:18-19` — `s.assert_and_track(variables['city'][0] == city_0_index, 'visit city in cities list')`
- `prompts/step_to_code_attraction_v2.txt:19-22` — `'valid attraction index'`, `'non repeating attraction index'`
- `prompts/step_to_code_transportation_methods.txt:12-30` — 20+ labelled constraints

**But:** the core is only *written to a file and printed*. **No code anywhere reads `unsat_info.txt` and acts on it.** No constraint is removed, no budget is raised, no retry happens. The `'budget enough'` label is the obvious relaxation lever and it is **NOT PRESENT IN CODE** as an action. The only recovery is the outer loop (`run_planner.py:438-441`), which skips a query if `plans/plan.txt` exists and otherwise re-runs the pipeline — i.e. **re-rolls the LLM and hopes.** That is the actual relaxation mechanism for this half of the system.

### 4.6 Hard vs soft constraints in the generated code

Everything in the generated path is **hard** (`assert_and_track` = hard + labelled). The only soft handling:

`run_planner.py:66-72` — objective-direction injection from a persona string:
```python
def add_spending_preference_constraints(user_persona, code):
    spending_preference = extract_spending_preference(user_persona)
    if spending_preference == "Luxury Traveler":
        code += "\ns.maximize(spent)\n"
    elif spending_preference == "Economical Traveler":
        code += "\ns.minimize(spent)\n"
    return code
```
This is appended *after* the budget constraint `spent <= budget_limit`, so it only picks the most/least expensive already-feasible point.

`prompts/step_to_code_attraction_v2.txt:23-28` — category preference as a linear reward:
```python
    category_exists = AttractionSearch.check_exists_any(attration_category_info, variables['attraction_in_which_city'][i], variable, ["Nature & Parks"])
    category_score.append(If(And(variable != -1,category_exists), 30, 0))
    AttractionSearch.add_weighted_category_scores(attration_category_info, variables['attraction_in_which_city'][i], variable, user_persona, category_score)
...
    s.maximize(Sum(category_score))
```
Magic weight `30` per matching category, plus an LLM/persona-driven weighted score.

### 4.7 The one genuinely hand-written part: day->city schedules

`run_planner.py:75-120` hard-codes, per trip length, the day->city mapping as nested `If` chains. For a 7-day trip (`L88-94`):
```python
        arrives.append(If(variables[1] == 1, transportation_arrtime[1], If(variables[2] == 1, transportation_arrtime[2], IntVal(-1))))
```
This is a hand-derived, trip-length-specific table of which day index each departure can land on. Duplicated verbatim in `z3_code_execution.py:42-87`. Adding a 4th city or a 4th departure requires hand-editing these — it is the least general part of the codebase.

---

## 5. PyVRP modelling

### 5.1 The `Model` builder is a pure builder, not a constraint model

`pyvrp/Model.py` has **no `opt.add` equivalent, no variables, no constraints**. It only accumulates typed data and hands it to C++ as `ProblemData`. All constraint semantics live in the C++ core (`pyvrp/cpp/*.h`, `pyvrp/cpp/search/*`).

Entity classes exposed (`Model.py:8-17`): `Client`, `ClientGroup`, `Depot`, `Location`, `ProblemData`, `Shipment`, `Solution`, `VehicleType`. Routing `Profile` + `Edge` are pure-Python containers (`Model.py:27-99`).

### 5.2 Time windows

`Model.py:237-251` — per-client:
```python
    def add_client(
        self,
        location: Location,
        delivery: int | list[int] = [],
        pickup: int | list[int] = [],
        service_duration: int = 0,
        tw_early: int = 0,
        tw_late: int = np.iinfo(np.int64).max,
        release_time: int = 0,
        prize: int = 0,
        required: bool = True,
        group: ClientGroup | None = None,
        *,
        name: str = "",
    ) -> Client:
```

Semantics are **start-of-service** windows, not visit windows, and there are three *separate* time parameters (`cpp/Client.h:40-51`):
- `tw_early` / `tw_late` — "Service should start (but not necessarily end) within the interval" (`Client.h:40-42`).
- `release_time` — a *different* thing: "Earliest time at which a vehicle may leave the depot on a trip to visit this client" (`Client.h:47-48`). A per-client gate on *departure*, not arrival.
- `service_duration` — "Amount of time a vehicle needs to spend at this client before resuming its route" (`Client.h:40-41`).

Depots get the same triple (`Model.py:358-384`): `tw_early`, `tw_late`, `service_duration`. Vehicles add `tw_early`/`tw_late`/`shift_duration`/`start_late` (`Model.py:428-450`).

**The critical implementation detail — time windows are *soft*, expressed as accumulated time warp, not as a hard rejection.** `cpp/Route.cpp:230`:
```cpp
    timeWarp_ = ds.timeWarp(vehData.maxDuration);
```
and `cpp/Route.cpp:252-253` computes the start time by *pushing* later:
```cpp
           std::max(start.twEarly, std::min(releaseTime_, start.twLate)),
           std::min(start.twLate, vehData.startLate),
```
i.e. `start = clamp(max(twEarly, releaseTime), ..., min(twLate, startLate))`. A late arrival simply accrues time warp. `CostEvaluator.h:196-199`:
```cpp
Cost CostEvaluator::twPenalty([[maybe_unused]] Duration timeWarp) const
{
    return static_cast<Cost>(timeWarp.get() * twPenalty_);
}
```

**ATHITI takeaway:** there is no "hard time window" in PyVRP. `is_feasible()` is `time_warp == 0 && excess_load == 0 && excess_distance == 0` (`_search.pyi:198-201`). If you need a hard window you must check it yourself after the solve, exactly as FloatTrip does (§6.4).

### 5.3 Capacity

Multi-dimensional, and shared with pickups/deliveries/backhaul. `Model.py:428-437` on the vehicle side:
```python
    def add_vehicle_type(
        self,
        num_available: int = 1,
        capacity: int | list[int] = [],
        ...
        max_distance: int = np.iinfo(np.int64).max,
        unit_distance_cost: int = 1,
        unit_duration_cost: int = 0,
```
`Model.py:496-520` normalises the scalar/list forms:
```python
        vehicle_type = VehicleType(
            num_available=num_available,
            capacity=[capacity] if isinstance(capacity, int) else capacity,
            ...
            max_reloads=max_reloads,
            max_overtime=max_overtime,
            unit_overtime_cost=unit_overtime_cost,
            name=name,
        )
```
Client side is symmetric: `delivery: list[int]`, `pickup: list[int]` (`Model.py:240-241`) — one entry per dimension. `Model.py:15` imports `Shipment`, the *asymmetric pickup-then-delivery* variant with its own per-leg time windows and service durations (`_pyvrp.pyi:168-209`).

Excess is linear, not a hard cap (`cpp/CostEvaluator.h:187-194`):
```cpp
Cost CostEvaluator::loadPenalty(Load load, Load capacity, size_t dimension) const
{
    assert(dimension < loadPenalties_.size());
    auto const excessLoad = std::max<Load>(load - capacity, 0);
    return static_cast<Cost>(excessLoad.get() * loadPenalties_[dimension]);
}
```

### 5.4 Precedence

**There is no precedence field.** `Client` has `delivery`/`pickup` (load direction), `group`, and `release_time`, but no "must come after client X". The `group` mechanism is the only ordering-adjacent structure and it is a *cardinality* constraint, not a sequencing one.

`cpp/ClientGroup.h:49-55`:
```cpp
    bool const required;                  // is visiting the group required?
    bool const mutuallyExclusive = true;  // at most one visit in group?
```
with docs (`ClientGroup.h:36-43`):
```
 *    mutually_exclusive
 *        When ``True``, exactly one of the clients in this group must be
 *        visited if the group is required, and at most one if the group is
 *        not required.
```
`mutuallyExclusive` is `const = true` and hard-coded — the note at `ClientGroup.h:19-21` says *"Only mutually exclusive client groups are supported for now."* So the entire generalised-group family is stubbed. `Model.py:274-277` even rejects the only meaningful combination:
```python
        if required and group is not None and group.mutually_exclusive:
            # Required clients cannot be part of a mutually exclusive client
            # group, since then there's nothing to decide about.
            raise ValueError("Required client in mutually exclusive group.")
```
`release_time` is the closest thing to precedence, and it is weak: it bounds *departure from the depot*, so it can never express "A before B" when both are on the same route.

**ATHITI takeaway: if you need `before`/`after` ordering, neither PyVRP nor FloatTrip's CP-SAT model gives it to you for free.** FloatTrip hand-rolls it with time-indexed implications (§6.2); do the same.

### 5.5 Multiple objectives — and the mechanism that makes them all work

`CostEvaluator.h:112-126` is the whole story — a **single scalarised objective**:
```
 *    .. math::
 *
 *    \sum_{R \in \mathcal{R}}
 *      \left[
 *          f_R + c^\text{distance}_R d_R
 *              + c^\text{duration}_R t_R
 *              + c^\text{overtime}_R o_R
 *      \right]
 *    + \sum_{i \in V} p_i - \sum_{R \in \mathcal{R}} \sum_{i \in V_R} p_i,
 *
 *    where the first part lists each route's fixed, distance, duration and
 *    overtime costs, respectively, and the second part the uncollected prizes
 *    of unplanned clients and shipments.
```

**Rewards (prizes) are not rewards — they are negative costs via uncollected prizes.** The `+ sum_{i in V} p_i` term is a constant across all solutions; the *decisive* term is `- sum_R sum_{i in V_R} p_i`, i.e. subtract the prizes of what you *did* collect. So visiting an optional client with prize `p` is worth `p`, and dropping it costs `p`. Constraints:

- `prize >= 0` enforced (`cpp/Client.cpp:78-79`, `cpp/Shipment.cpp:75-76`).
- `required=True` and `prize=0` is the "hard" case (`Model.py:247` default `required: bool = True`).
- `cpp/Client.h:54-61`: *"Prize collected by visiting this client. Default 0. If this client is not required, the prize needs to be sufficiently large to offset any travel cost before this client will be visited in a solution."* — i.e. **PyVRP does not tune the prize for you**; the modeller must set `p >> max travel cost`.
- Two dedicated operators exploit this: `RemoveOptionalClient` (unary) and `ReplaceOptionalClient` (binary) (`_search.pyi:51, 56`), plus `RelocateAlternative` which explicitly moves between prize levels (`cpp/search/RelocateAlternative.cpp:30`: `Cost deltaCost = uData.prize - alternativeData.prize;`).

Penalty, TW and distance coexist because they are just extra linear terms in the same scalar (`CostEvaluator.h:175-185`):
```cpp
Cost CostEvaluator::excessLoadPenalties(std::vector<Load> const &excessLoads) const
{
    Cost cost = 0;
    for (size_t dim = 0; dim != loadPenalties_.size(); ++dim)
        cost += loadPenalties_[dim] * excessLoads[dim].get();
    return cost;
}
```

**And the true cost function is a step function**, `CostEvaluator.h:212-218`:
```cpp
template <typename T> Cost CostEvaluator::cost(T const &arg) const
{
    // Penalties are zero when the solution is feasible, so we can fall back to
    // penalised cost in that case.
    return arg.isFeasible() ? penalisedCost(arg)
                            : std::numeric_limits<Cost>::max();
}
```
So the *reported*/compared cost is `+inf` for any infeasible solution, while the *search* uses `penalised_cost`. `IteratedLocalSearch.py:222-223` and `:255-256` show the split:
```python
        cost_eval = self._pm.cost_evaluator()
        while not stop(cost_eval.cost(best)):
            ...
            cost_eval = self._pm.cost_evaluator()
            cand = self._search(curr, cost_eval, exhaustive=False)
            self._pm.register(cand)
            ...
            cand_cost = cost_eval.penalised_cost(cand)
            curr_cost = cost_eval.penalised_cost(curr)
```

### 5.6 What the penalty manager *actually* does

**It is a two-tier adaptive controller over a 1-D feasible-ratio target, and it does NOT touch distances-as-objective or prizes.** Three things only:

1. **Three penalty channels, fixed order** (`PenaltyManager.py:171-179`):
```python
    def penalties(self) -> tuple[list[float], float, float]:
        """
        Returns the current penalty values.
        """
        return (
            self._penalties[:-2].tolist(),  # loads
            self._penalties[-2],  # duration
            self._penalties[-1],  # distance
        )
```
i.e. `[load_penalty per dimension..., timewarp_penalty, excess_distance_penalty]`.

2. **Registration source** (`PenaltyManager.py:233-244`) — three violation scalars, integer counts:
```python
    def register(self, sol: Solution):
        """
        Registers the violations per penalty dimension of the given solution.
        """
        violations = [
            *sol.excess_load(),
            sol.time_warp(),
            sol.excess_distance(),
        ]
        for idx, violation in enumerate(violations):
            self._register(idx, violation)
```

3. **The update rule** — bang-bang multiplicative, gated on a window of 500 registrations (`PenaltyManager.py:181-198`, defaults at `:83-89`):
```python
    def _compute(self, penalty: float, feas_percentage: float) -> float:
        # Computes and returns the new penalty value, given the current value
        # and the percentage of feasible solutions since the last update.
        diff = self._params.target_feasible - feas_percentage

        if abs(diff) < self._params.feas_tolerance:
            return penalty

        if diff > 0:
            new_penalty = self._params.penalty_increase * penalty
        else:
            new_penalty = self._params.penalty_decrease * penalty

        return np.clip(
            new_penalty,
            self._params.min_penalty,
            self._params.max_penalty,
        )
```
```python
    solutions_between_updates: int = 500
    penalty_increase: float = 1.50
    penalty_decrease: float = 0.90
    target_feasible: float = 0.65
    feas_tolerance: float = 0.05
    min_penalty: float = 0.1
    max_penalty: float = 100_000.0
```
Feasible percentage is the mean of `violation == 0` over the window (`PenaltyManager.py:207`):
```python
        feas_percentage = fmean(violation == 0 for violation in viol_list)
```

Initialisation is deliberately mid-range, not zero (`PenaltyManager.py:113-132`):
```python
    def midpoint_penalties(
        self, data: ProblemData
    ) -> tuple[list[float], float, float]:
        """
        Returns initial penalty values at the midpoint between ``min_penalty``
        and ``max_penalty``.
        """
        midpoint = self.min_penalty + (self.max_penalty - self.min_penalty) / 2
        return ([midpoint] * data.num_load_dimensions, midpoint, midpoint)
```
— for the defaults that is `50_000.05` per channel. There is also a **stall detector** that warns when the penalty is pinned at max and violations have stopped improving (`PenaltyManager.py:211-228`, `PenaltyBoundWarning`).

Two exports: the live evaluator and a `max_cost_evaluator()` with every channel at `max_penalty` (`PenaltyManager.py:253-259`) — used for feasibility repair.

**Explicitly NOT in the penalty manager:** route *distance* is only penalised when *exceeding `max_distance`*, never as a "keep routes short" term. There is no "cross-cluster arc" penalty, no "too many stops" penalty, no "don't revisit" term. The "distance" the manager sees is `sol.excess_distance()` = route distance minus vehicle `max_distance`, which is 0 for any normal instance. **So on a normal instance the penalty manager is effectively a one-channel time-warp controller.** This matters: the "avoid local optima" claim is about *feasibility pressure*, not about diversity of solutions.

### 5.7 Local optima avoidance: Late-Acceptance Hill-Climbing ILS + granular neighbourhoods + ruin-and-recreate

`pyvrp/IteratedLocalSearch.py:168-207` names the acceptance criterion (Burke & Bykov 2017, LAHC). The loop, `IteratedLocalSearch.py:216-282`:

```python
        history: RingBuffer[Solution] = RingBuffer(self._params.history_length)
        ...
        best = curr = self._init
        ...
        while not stop(cost_eval.cost(best)):
            iters += 1

            if iters_no_improvement == self._params.num_iters_no_improvement:
                print_progress.restart()
                history.clear()

                curr = best
                iters_no_improvement = 0

                callbacks.on_restart(best)

            cost_eval = self._pm.cost_evaluator()
            cand = self._search(curr, cost_eval, exhaustive=False)
            self._pm.register(cand)

            iters_no_improvement += 1
            if cost_eval.cost(cand) < cost_eval.cost(best):
                best = cand
                iters_no_improvement = 0

                if self._params.exhaustive_on_best:
                    # Candidate is already a new (global) best, but let's see
                    # if we can improve it via an exhaustive search. That new
                    # candidate solution might be infeasible, so we need to
                    # check before updating best.
                    cand = self._search(cand, cost_eval, exhaustive=True)
                    if cand.is_feasible():
                        best = cand

            cand_cost = cost_eval.penalised_cost(cand)
            curr_cost = cost_eval.penalised_cost(curr)

            # We use either the initial cost or the current cost value from
            # some iterations ago to determine whether to accept the candidate
            # solution, if available.
            late_cost = cost_eval.penalised_cost(self._init)
            if (late := history.peek()) is not None:
                late_cost = cost_eval.penalised_cost(late)

            # Late-acceptance hill climbing of Burke and Bykov (2017). We use
            # both enhancements of section 4.2:
            # 1. We accept also when the candidate improves over the current
            #    solution;
            if cand_cost < late_cost or cand_cost < curr_cost:
                curr = cand
                curr_cost = cand_cost

            # 2. We update the history only when the current solution is better
            #    than the one already in the history.
            if curr_cost < late_cost or late is None:
                history.append(curr)
            else:
                history.skip()
```

Defaults (`IteratedLocalSearch.py:88-90`): `num_iters_no_improvement = 150_000`, `history_length = 300`, `exhaustive_on_best = True`.

**Anti-local-optima mechanisms, all of them:**
1. **LAHC** — accept a *worse* solution if it beats the cost from `history_length` iterations ago. The plateau/walk mechanism that beats plain hill-climbing.
2. **Adaptive penalties** — the feasibility/objective trade-off moves during the run (§5.6), so the search does not commit to one objective weighting.
3. **Restart from best** after 150k non-improving iterations, with history cleared.
4. **Exhaustive polish on every new global best** (`exhaustive=True`), guarded by `is_feasible()` because the exhaustive pass may regress.
5. **Granular neighbourhoods** — a k-nearest-neighbour list, `num_neighbours=50`, `weight_wait_time=0.2`, `symmetric_proximity=True` (`_search.pyi:276-291`). Moves are evaluated only against the neighbourhood. A speed measure, not a quality measure.
6. **Ruin-and-recreate perturbation** before each LS call: `PerturbationManager` with `min_perturbations=1`, `max_perturbations=25` (`_search.pyi:97-120`).
7. **19 neighbourhood operators** in the default set (`_search.pyi:48-70`): relocate 1/2/3, swap 1-1/2-1/2-2/3-1/3-2/3-3, relocate-with-depot, swap-tails, relocate-alternative, insert/replace/remove-optional-client/shipment, replace-group, relocate-pickup/delivery/shipment, remove-adjacent-depot.
8. **Randomised operator application order** — `ls.shuffle(self._rng)` on *every* call (`LocalSearch.py:124`), and `Solution.make_random(data, rng)` for the initial solution (`solve.py:179`).

Wiring (`solve.py:163-182`): `rng`, `compute_neighbours`, `PerturbationManager`, `LocalSearch`, operator registration gated on `op.supports(data)`, then `IteratedLocalSearch.run(stop)`. `stop` is any callable on the current best cost.

### 5.8 Not present in PyVRP (checked)

- **No precedence/sequencing.** Confirmed above (§5.4).
- **No multi-objective (lexicographic / Pareto) API.** Everything is scalarised into one `CostEvaluator`. Confirmed: one `cost()`, one `penalisedCost()`.
- **No prize auto-tuning.** You must set it.
- **No Python-accessible "add a constraint" hook.** You cannot express a constraint PyVRP doesn't know about. This is the hard constraint on using it for ATHITI.

---

## 6. FloatTrip route clustering

### 6.1 The clustering: hand-rolled deterministic k-means on haversine km, `k = days`

`app/planning/helpers.py:73-124` — full function, verbatim:

```python
def cluster_pois_by_location(
    pois: list[dict[str, Any]], k: int
) -> dict[str, int]:
    """按经纬度把候选景点聚成 k 个地理分区，返回 {景点名: 分区编号(0-based)}。"""
    result: dict[str, int] = {}
    valid: list[tuple[str, dict[str, float]]] = []
    for s in pois:
        loc = s.get("location")
        if _has_coords(loc):
            valid.append((s["name"], loc))
        else:
            result[s["name"]] = -1

    n = len(valid)
    if n == 0:
        return result
    k = max(1, min(k, n))
    if k == 1:
        for name, _ in valid:
            result[name] = 0
        return result

    # 确定性初始化：按经度（再纬度）排序后等距取 k 个种子
    ordered = sorted(valid, key=lambda x: (x[1]["lng"], x[1]["lat"]))
    centroids = [
        {"lat": ordered[round(i * (n - 1) / (k - 1))][1]["lat"],
         "lng": ordered[round(i * (n - 1) / (k - 1))][1]["lng"]}
        for i in range(k)
    ]

    assign: dict[str, int] = {}
    for _ in range(20):
        new_assign = {
            name: min(range(k), key=lambda c: haversine_km(centroids[c], loc))
            for name, loc in valid
        }
        if new_assign == assign:
            break
        assign = new_assign
        for c in range(k):
            members = [loc for name, loc in valid if assign[name] == c]
            if members:
                centroids[c] = {
                    "lat": sum(m["lat"] for m in members) / len(members),
                    "lng": sum(m["lng"] for m in members) / len(members),
                }

    result.update(assign)
    return result
```

Precise characterisation:
- **Algorithm:** Lloyd's k-means, hard assignment, **no k-means++**. Deterministic seeding: sort by `(lng, lat)`, then take `k` points at *equal index spacing* `round(i*(n-1)/(k-1))`. This is "farthest-along-a-projection" seeding, not maximum-minimum dispersion. It can be badly wrong for a set whose long axis is not longitude.
- **Feature space:** **only `(lat, lng)`**. No POI attributes, no category, no rating, no duration. Pure geography.
- **Distance metric:** haversine, `EARTH_RADIUS_KM = 6371.0088` (`helpers.py:52-62`). km.
- **Iterations:** max 20, early break on assignment stability.
- **Degeneracies:** POIs without coords -> cluster `-1`; `k=1` -> everything cluster 0; `k = max(1, min(k, n))`; an empty cluster keeps its stale seed centroid (no re-seed, no empty-cluster repair).
- **Centroid update is an arithmetic mean of lat/lng**, not a spherical centroid. Fine at city scale.
- **`k` is always the number of days.** Four call sites, all `max(1, days)`: `app/planning/candidate_builder.py:116`, `app/planning/nodes.py:303`, `:450`, `:597`.

**This is a *label*, not a constraint.** The cluster id is a soft penalty input — `app/planning/optimizer.py:474-477`:
```python
                    if left.cluster_id != right.cluster_id:
                        objective_terms.append(
                            arc * -int(round(self.profile.penalties.cross_cluster_arc * scale))
                        )
```
and it is fed to the LLM as an advisory marker (`app/planning/prompts.py:21-24`):
```
    "   【景点相邻】⚠️ 这个是必须满足的指标 对照候选池的『📍地理分区』标注"
    "（按真实坐标距离划分，比行政区更准——⚠️行政区名/区域相同不代表距离近，"
    "务必以『地理分区』为准）：优先把同一地理分区的景点排在同一天，不同分区尽量"
    "分到不同天；只有当某分区景点过多/过少需要平衡各天时才跨分区，并说明原因。\n"
```

### 6.2 The Packer: OR-Tools CP-SAT with `AddCircuit` per day

`app/planning/optimizer.py:274-601`. The decisive structural move is `AddCircuit` with a fixed closing arc and self-loops for unselected POIs (`optimizer.py:380-400`):

```python
            # Open path via AddCircuit: end -> start is fixed and unselected POIs
            # take their self loops.  All other active arcs form one day route.
            start_node, end_node = 0, 1
            circuit: list[tuple[int, int, Any]] = [(end_node, start_node, model.NewConstant(1))]
            empty = model.NewBoolVar(f"empty_{day}")
            circuit.append((start_node, end_node, empty))
            for i in range(count):
                node = i + 2
                circuit.append((node, node, x[i, day].Not()))
                start_arc = model.NewBoolVar(f"arc_start_{i}_{day}")
                end_arc = model.NewBoolVar(f"arc_end_{i}_{day}")
                arcs[-1, i, day] = start_arc
                arcs[i, -2, day] = end_arc
                circuit.extend(((start_node, node, start_arc), (node, end_node, end_arc)))
                for j in range(count):
                    if i == j:
                        continue
                    arc = model.NewBoolVar(f"arc_{i}_{j}_{day}")
                    arcs[i, j, day] = arc
                    circuit.append((node, j + 2, arc))
            model.AddCircuit(circuit)
```

`AddCircuit` enforces a single Hamiltonian circuit over the active arcs, so it does **assignment, sequencing and subtour elimination in one constraint**. The constant-`1` arc `(end, start)` forces a cycle to exist; unselected POIs self-loop, which makes the circuit trivially satisfiable; `arcs[-1,i,day]` and `arcs[i,-2,day]` give the model its start/end. This is the single most valuable idea in the whole FloatTrip codebase and it maps to **cheapest-insertion + 2-opt + Or-opt** in pure TS with the same semantics.

Hard constraints registered (all `model.Add`):

| Constraint | Lines | Encoding |
|---|---|---|
| assign-or-not | `:359` | `selected[i] == sum_d x[i,d]` |
| must-visit | `:360-361` | `selected[i] == 1` |
| fixed day | `:362-366` | `x[i, target] == 1`, early `return None` if out of range |
| daily count band | `:374-377` | `pace.minimum <= sum_i x[i,d] <= pace.maximum` |
| opening-hours window | `:408-420` | `start[i,d] >= lo` / `<= hi` **OnlyEnforceIf** `x[i,d]`; `start == DAY_START` if not selected |
| closed-on-date | `:411-413` | `x[i,d] == 0` if `_closed_on_date` |
| first/last stop | `:402-406` | `arcs[-1,i,d] == x[i,d]`, `arcs[i,-2,d] == x[i,d]` |
| meal coverage | `:423-433` | `cover <= x`, `cover == 0` if scene not allowed, else two window implications; `cover_lunch + cover_dinner <= 1` |
| preferred period | `:441-453` | `period_match` bool + window implications |
| **no overlap along the route** | `:463-470` | `starts[j,d] >= starts[i,d] + dur_i + TRANSFER_MIN` **OnlyEnforceIf(arc)** |
| same-day precedence | `:492-500` | `starts[j,d] >= starts[i,d] + dur_i + TRANSFER_MIN` OnlyEnforceIf both selected |
| category presence | `:502-509` | `sum_{i in cat} x[i,d] >= present` and `present >= x[i,d]` for all i |
| day load balance | `:511-522` | `AddMaxEquality` / `AddMinEquality` on per-day `load` |
| **cross-day precedence** | `:524-534` | `AddBoolOr([x[i,pd].Not(), x[j,sd].Not()])` for all `sd < pd` |

Constants (`optimizer.py:27-34`): `DAY_START = 9*60`, `DAY_END = 21*60`, `TRANSFER_MIN = 20`, `LUNCH_WINDOW = (11:30, 13:30)`, `DINNER_WINDOW = (17:30, 20:00)`, `MIN_MEAL_OVERLAP = 45`, `DEFAULT_SOLVER_SECONDS = 1.0`, `DEFAULT_RANDOM_SEED = 20260816`.

Objective: `model.Maximize(sum(objective_terms))` (`optimizer.py:536`) — a single scalarised integer objective, 6 rewards + 8 penalties, all scaled by `objective_scale`. Weights in `app/planning/scoring_profiles/balanced-v1.yaml`, with `objective_scale: 6000` and a comment explaining the integer-exactness trick:
```yaml
# 6000 is divisible by 5, 10, 60 and 100, so ratings, 0.1-km
# distances, and per-minute penalties all remain exact integer CP-SAT terms.
objective_scale: 6000
rewards:
  amap_rating: 1.00
  preference_match: 1.50
  representativeness: 1.20
  category_diversity: 0.50
  daily_target_fill: 0.80
  meal_scene_match: 0.75
penalties:
  distance_per_km: 0.12
  preferred_period_miss: 0.60
  meal_scene_miss: 0.50
  weather_mismatch: 1.00
  consecutive_high_fatigue: 0.50
  cross_cluster_arc: 0.35
  waiting_per_hour: 0.25
  daily_load_imbalance_per_hour: 0.30
```

Cross-day imbalance is `max(loads) - min(loads)` (`optimizer.py:516-522`) — matching the offline evaluator exactly (`scoring.py:180`: `raw["daily_load_imbalance_per_hour"] = max(loads) - min(loads)`), which is how they keep solver and audit in agreement.

Solver config (`optimizer.py:537-541`): `max_time_in_seconds = 1.0`, `num_search_workers = 1`, `random_seed = 20260816`, `randomize_search = False`. **1 second, single-threaded** — demo-grade, and the result is `FEASIBLE` more often than `OPTIMAL`.

The pace band comes from a *rule* on the habit string (`optimizer.py:100-110`):
```python
def pace_range(habit: str | None, max_per_day: int) -> PaceRange:
    text = (habit or "").lower()
    if any(token in text for token in ("慢", "轻松", "休闲", "不赶")):
        lower, upper = 2, 3
    elif any(token in text for token in ("紧凑", "特种兵", "尽量多", "多打卡", "赶行程")):
        lower, upper = 4, 5
    else:
        lower, upper = 3, 4
    upper = max(1, min(upper, max_per_day))
    lower = min(lower, upper)
    return PaceRange(lower, upper, upper)
```

### 6.3 Relaxation: two-tier, no core

`optimizer.py:320-330` — the whole recovery ladder:

```python
        first = self._solve_cp_sat(normalized, days, pace, weather_by_day, travel_start_date, relaxed=False)
        if first is not None:
            return first
        relaxed_pace = replace(pace, minimum=max(1, user_daily_min or 0))
        second = self._solve_cp_sat(normalized, days, relaxed_pace, weather_by_day, travel_start_date, relaxed=True)
        if second is not None:
            return second
        fallback = self._fallback(normalized, days, relaxed_pace, weather_by_day, travel_start_date)
        if fallback is None:
            raise OptimizationFailure("no feasible route after daily-min relaxation and fallback")
        return fallback
```

Three tiers: (1) CP-SAT with the full pace band; (2) CP-SAT with `pace.minimum` dropped to the user's explicit minimum or 1, tagged `relaxed_constraints=["RELAXED_DAILY_MIN"]` (`optimizer.py:589`); (3) a deterministic greedy fallback. **Exactly one constraint is ever relaxed** — the daily minimum count. `unsat_core` / `assert_and_track` / `assumption`: **NOT PRESENT IN CODE.** INFEASIBLE just returns `None` from `_solve_cp_sat` (`optimizer.py:543-544`).

### 6.4 The deterministic fallback — and the independent audit

`_fallback` (`optimizer.py:603-675`) is a **greedy nearest-centroid day assignment + exhaustive per-day permutation**:
```python
                eligible = [day for day in range(days) if len(by_day[day]) < pace.maximum]
                if not eligible:
                    break
                target = min(
                    eligible,
                    key=lambda day: (
                        len(by_day[day]),
                        sum(
                            haversine_km(candidate.location, existing.location)
                            for existing in by_day[day]
                        ) / max(1, len(by_day[day])),
                        day,
                    ),
                )
```
— i.e. **least-loaded day, tie-broken by smallest mean distance to that day's existing POIs**. That is the "cluster-aware" idea implemented in ~15 lines with no clustering at all.

Then `_best_feasible_permutation` (`optimizer.py:228-261`) does `itertools.permutations(sorted(names))` — **brute force over the factorial**, viable only because `pace.maximum <= 5`. It rejects permutations that break `must_be_first` / `must_be_last` / `before_poi_names`, then runs `_earliest_schedule` (a forward greedy earliest-start scheduler that returns `None` on any window violation, `optimizer.py:207-225`) and keeps the min-distance feasible one:
```python
def _earliest_schedule(
    ordered: Sequence[Mapping[str, Any]],
    visit_date: date | None = None,
) -> list[tuple[int, int]] | None:
    schedule: list[tuple[int, int]] = []
    cursor = DAY_START
    for candidate in ordered:
        if _closed_on_date(candidate.get("open_time"), visit_date):
            return None
        bounds = _allowed_start_bounds(candidate)
        if bounds is None:
            return None
        start = max(cursor, bounds[0])
        if start > bounds[1]:
            return None
        end = start + int(candidate["duration_min"])
        schedule.append((start, end))
        cursor = end + TRANSFER_MIN
    return schedule
```

`validate_solution` (`optimizer.py:705-812`) is a **fully independent re-implementation** of every hard constraint plus a **solver-objective cross-check**:
```python
    recomputed, _ = evaluate_itinerary(route, candidate_map, profile, daily_target=pace.target, weather_by_day=weather_by_day)
    delta = None if diagnostics.objective is None else abs(recomputed - diagnostics.objective)
    if delta is not None and delta > 1e-6:
        violations.append(QualityViolation(code="OBJECTIVE_MISMATCH", message=f"objective delta={delta:.8f}"))
```
and a shortest-possible-order ratio per day, explicitly demoted to a diagnostic (`optimizer.py:802-804`):
```python
        # Distance is a soft objective alongside opening hours, meal coverage,
        # waiting time, and preference fit. Keep this ratio as a diagnostic;
        # it must not reject a feasible, higher-scoring optimizer route.
```

`evaluate_itinerary` (`scoring.py:111-200`) recomputes the objective from the route alone, *"without consulting solver variables"* (`:119`) — the deliberate separation that lets them catch solver bugs.

### 6.5 Does the LLM choose the route, or just narrate it?

**Neither — and this is the repo's best idea.** The core pipeline is `app/planning/graph.py:76-96`:
```python
    g.add_node("weather_lookup", _with_progress("weather_lookup", weather_lookup_node))
    g.add_node("attraction_search", _with_progress("attraction_search", attraction_search_node))
    g.add_node("candidate_builder", _with_progress("candidate_builder", make_candidate_builder_node(model_name)))
    g.add_node("optimizer", _with_progress("optimizer", optimize_attractions_node))
    g.add_node("quality_gate", _with_progress("quality_gate", quality_gate_node))
    g.add_node("finalize", _with_progress("finalize", make_finalize_node(memory_writer)))
    g.add_edge(START, "weather_lookup")
    g.add_edge("weather_lookup", "attraction_search")
    g.add_edge("attraction_search", "candidate_builder")
    g.add_edge("candidate_builder", "optimizer")
    g.add_edge("optimizer", "quality_gate")
    g.add_conditional_edges(
        "quality_gate",
        route_after_quality_gate,
        {"candidate_builder": "candidate_builder", "finalize": "finalize"},
    )
    g.add_edge("finalize",       END)
```

- The LLM's role in the *core* path is **attribute labelling only**: `CANDIDATE_BUILDER_SYSTEM` (`prompts.py:87-94`) — *"你是候选景点语义标注器，不负责排路线，也不能决定评分权重"* ("you are the candidate-POI semantic labeller; you are **not** responsible for the route and cannot decide the scoring weights"). It fills `duration_min in [30,360]`, `preference_match in [0,1]`, `representativeness in [0,1]`, `preferred_period`, `meal_scene`, `semantic_tags`.
- Server-side rules then *overwrite* the model's guesses for anything hard (`candidate_builder.py:41-80`): `must_visit`, `fixed_day`, `fixed_start_min`, `must_be_first`, `must_be_last`, `before_poi_names` are all **regex-mined from the confirmed constraint text** (`第N天`/`Day N`, `HH:MM` + 预约/固定/准时/开始, 首站/第一站/最先, 末站/最后一站/最后去, 之前/先于), never taken from the LLM.
- Hard filter: `excluded_poi_names` removes every POI whose name appears in an `avoid` constraint (`candidate_builder.py:26-34`).
- The LLM chooses the route only in the **post-solver revision graph** (`graph.py:154-181`: `planner -> revision_concern -> reviewer -> (planner | meal_search) -> meal_recommend -> finalize`), and even there it operates on a **frozen candidate pool** (`nodes.py:391`: `"candidate_pool_frozen": True`).
- Constraint memory polarity enum: `Literal["prefer", "avoid", "require", "fact"]` (`app/chat/models.py:23`), DB-enforced `CHECK(polarity IN ('prefer','avoid','require','fact'))` (`app/core/database.py:193`).

**So: in the core path the LLM does not choose the route. The solver does, and the LLM labels, reviews and narrates.** This is the pattern ATHITI should copy.

---

## 7. RouteMind OR-Tools integration

### 7.0 Path correction + a mis-assignment in the manifest

The brief gave `peer/routemind-pritesh/`. That path does not exist. `repos.tsv:111` and `MANIFEST.json:1619-1623` both say the correct path is **`systems/routemind-pritesh/`**. Additionally, `repos.tsv:86` and `:111` give *identical* descriptions ("RAG + embeddings + OR-Tools + Google Maps") for two different repositories, and that description is **wrong for `routemind-pritesh`** — see §7.4.

Also note `peer/routemind` is **not** a JS project. It is a `Next.js 14 + TypeScript` frontend over a **FastAPI/Python** backend (README tech-stack table). The "JS" label in the brief is wrong.

### 7.1 Which OR-Tools API is used: `ortools.sat.python.cp_model` (CP-SAT), only

`peer/routemind/backend/requirements.txt` pins `ortools==9.10.4067`. Single import site, `backend/app/core/ortools_optimizer.py:4`:
```python
from ortools.sat.python import cp_model
```

**`ortools.constraint_solver` / `routing.py_routing` / `RoutingModel` / `RoutingIndexManager` are NOT PRESENT IN CODE.** No `AddDimension`, no `CumulVar`, no `pywrapcp`. Grep for `ortools`, `routing.Model`, `CP_SAT`, `RoutingIndexManager`, `pywrapcp`, `AddDimension`, `AddConstraint` across both repos: the only hits are `cp_model` in `ortools_optimizer.py` and in `floattrip/app/planning/optimizer.py:14`.

**So: neither RouteMind nor any other repo in this set uses OR-Tools' *routing* library. Both use CP-SAT, and RouteMind does not even build a circuit.** This is the single most important finding for topic 7: there is no "real project wiring a `RoutingModel`" anywhere in this corpus. RouteMind's own file name (`ortools_optimizer.py`) is a misnomer, and the docstring at `:33` says *"Build an optimized itinerary using OR-Tools CP-SAT solver"* while `:49-51` says:
```python
    # For now, use greedy as fallback for complex cases
    # OR-Tools implementation for full optimization would be very complex
    # This is a simplified version that demonstrates the approach
```

### 7.2 Constraints RouteMind's CP-SAT actually registers

`backend/app/core/ortools_optimizer.py`. Variables: one `BoolVar` per `(day, activity)` (`:83-87`). That is **all** — no start-time, no arc, no circuit variable.

```python
    # 1. Budget constraint per day (using cents to avoid floats)
    for day in range(trip_days):
        daily_cost = sum(
            activity_selected[(day, act_idx)] * int(available_activities[act_idx].base_cost * 100)
            for act_idx in range(len(available_activities))
        )
        model.Add(daily_cost <= int(daily_budget_cents * 1.2))  # Allow 20% flexibility
```
```python
    # 2. Activity count per day (based on energy level)
    for day in range(trip_days):
        daily_count = sum(...)
        model.Add(daily_count >= min_activities)
        model.Add(daily_count <= max_activities)
```
```python
    # 3. Must-visit activities must be included somewhere
        model.Add(sum(activity_selected[(day, act_idx)] for day in range(trip_days) for act_idx in must_visit_indices) >= 1)
```
```python
    # 4. No duplicate activities in same day (unless must-visit)
        model.Add(activity_selected[(day, act_idx)] <= 1)   # tautology on a BoolVar
```
Objective: `model.Maximize(sum(total_utility))` (`:162`) where each term is `x * round(score*100)` (`:153-160`).

**Genuinely registered: three constraint types — budget <= (with a hardcoded 20 % slack fudge), day-count band, must-visit >= 1. Plus one tautology. There is NO time-window variable, NO no-overlap, NO sequencing, NO travel-time coupling, NO capacity, NO precedence.** The energy band comes from `get_activities_per_day` (`backend/app/core/optimizer.py:33-39`): `relaxed (2,3)`, `moderate (3,5)`, `active (5,7)`.

**The ordering and scheduling is done greedily, outside the solver** — `ortools_optimizer.py:190` says so literally: `# Order activities using greedy (simpler than full TSP)`. The greedy loop (`:198-285`) recomputes `score_activity` with the current `day_state` and `previous_activity`, checks `is_activity_available` and a remaining-time check, and takes the argmax. `is_activity_available` (`optimizer.py:49-60`) is an `open_time`/`close_time` hour comparison against `current_time`.

Wiring: `build_itinerary(preferences, activities, use_ortools=settings.USE_ORTOOLS)` (`optimizer.py:125-146`) with `USE_ORTOOLS: bool = True` (`app/config.py:82`), and `except ImportError: pass` -> silent greedy fallback. Called from `api/routes.py:509`, `agent_service.py:233, 270`; `multi_city_planner.py:215` hardcodes `use_ortools=False`.

### 7.3 Embedding + RAG retrieval shape

Three-layer, with graceful degradation at every layer.

**Document text** (`app/services/embedding_service.py:10-32`):
```python
    parts = [
        f"Activity: {activity.name}",
        f"Category: {activity.category}",
    ]
    if activity.description:
        parts.append(f"Description: {activity.description}")
    if activity.tags:
        parts.append(f"Tags: {', '.join(activity.tags)}")
    parts.append(f"Duration: {activity.avg_duration_minutes} minutes")
    parts.append(f"Cost: ${activity.base_cost:.2f}")
    parts.append(f"Rating: {activity.rating:.1f}/5")
    return "\n".join(parts)
```

**Query text** — a *synthesised English sentence* from structured preferences, not the user's words (`embedding_service.py:48-61`):
```python
    parts = [
        f"Looking for activities for a {trip_type.replace('_', ' ')} trip.",
        f"Energy level: {energy_level}.",
    ]
    if categories:
        parts.append(f"Preferred categories: {', '.join(categories)}.")
    parts.append(f"Budget: {budget_level}.")
    if constraints_text:
        parts.append(constraints_text)
    return " ".join(parts)
```

**Embedder**: `openai.AsyncOpenAI().embeddings.create(model=settings.EMBEDDING_MODEL)`, `EMBEDDING_MODEL = "text-embedding-3-small"`, 1536-d (`app/config.py:27`, `embedding_service.py:77-81`).

**Store + query** — pgvector `<=>` cosine distance, **per-city hard filter, `LIMIT :top_k`, `RAG_TOP_K = 50`** (`app/config.py:28`; `app/services/retrieval_service.py:84-92`):
```sql
            SELECT a.id, ae.embedding_vec <=> CAST(:embedding AS vector) AS distance
            FROM activity_embeddings ae
            JOIN activities a ON ae.activity_id = a.id
            WHERE a.city_id = :city_id
              AND ae.embedding_vec IS NOT NULL
            ORDER BY distance ASC
            LIMIT :top_k
```

**Fallbacks, four separate ones** (`retrieval_service.py:32-36, 65-67, 100-102, 114-116`): RAG disabled, no embeddings for the city, zero rows, any exception -> `_fallback_sql(city_id, db)` which returns **every activity in the city with no ordering at all** (`:119-123`).

**Rank preservation** — a real bug they caught and worked around (`retrieval_service.py:104-109`):
```python
        activity_ids = [row[0] for row in rows]
        activities = db.query(Activity).filter(Activity.id.in_(activity_ids)).all()
        # Preserve ranking order from pgvector
        id_order = {aid: idx for idx, aid in enumerate(activity_ids)}
        activities.sort(key=lambda a: id_order.get(a.id, 999))
```

**The seam that matters:** `score_activity` has a `semantic_relevance_score: Optional[float]` parameter (`app/core/scoring.py:63`) and uses it (`:175`, `:191`). **The OR-Tools path passes `None`** — `ortools_optimizer.py:155`:
```python
            score = score_activity(activity, preferences, day_state, None)
```
and it passes `None` in the greedy loop too (`:238-240` — only 3 of 4 args are given, so `previous_activity` is not even used for the score). **So the RAG ranking is computed and then thrown away: only the *set* of 50 matters, the *order* is discarded.** `app/api/schemas.py:100` still documents the field (`"Cosine similarity score from RAG (0-1)"`) but it is `None` on both real paths.

This is exactly the thing ATHITI must not repeat: **put the cosine score into the ranking objective, or you have paid for RAG and bought nothing.**

### 7.4 `systems/routemind-pritesh` — the manifest description is wrong

`README.md:1-5`:
```
# RouteMind

> Intelligent AI model routing — one interface, the right model, every time.

RouteMind eliminates the decision fatigue of choosing between AI tools. Instead of manually switching between ChatGPT, Claude, Gemini, and others depending on your task, RouteMind analyses your query and automatically routes it to the most suitable model — then explains why.
```

**It is an LLM-provider router, not a travel planner.** Verified by exhaustive grep across the whole repo (excluding `.git`/`node_modules`):
- `ortools` -> **NONE**
- `itinerary` / `travel` / `point of interest` / `poi` -> **NONE**
- `embedding` / `pgvector` / `vector` in `backend/` -> only `backend/app/services/memory_service.py` (conversation memory, unrelated)

Stack: React 19 + Vite 8 + FastAPI + SQLite + SQLAlchemy, providers for OpenAI/Groq/Gemini/NVIDIA/OpenRouter, `RuleBasedIntentClassifier` (`backend/app/classifier/intent_classifier.py`), `provider_manager.py`, `router.py`. `backend/requirements.txt` is UTF-16 encoded and contains **no `ortools`**. CI is Prettier + Vitest + build only.

`repos.tsv:111` describes it as *"RAG + embeddings + OR-Tools + Google Maps"* — that string is verbatim-identical to `repos.tsv:86` (the *other* RouteMind) and is **a copy-paste error**. `repos.tsv:111`'s own caveat ("The masterplan flags this as a modest-scope project we should NOT quote as a benchmark without checking ourselves") was justified.

**There is no `peer/routemind-pritesh`. There is exactly one RouteMind with a travel planner in it, it is `peer/routemind`, and it is a Python+TS hybrid, not JS.**

---

## 8. UGuideRAG's three dimensions

### 8.1 The prompt template — confirms all three, and confirms a typo

`Code/SearchEngine.py:16-56` (`_process_input_prompt`). The schema, verbatim from the prompt:

```
    ### Output Format:

    Return a list where each item is a dictionary representing an independent requirement, with the following key-value pairs:
    - **expected landscape and content**: Try to extract what kind of landscape or content the user want to visit.
    - **expected activities**: Try to extract the activities the user want to do.
    - **expected atomosphere**: Atomosphere usually could be described by quiet, romantic, cozy,majestic and so on.

    - Your return should be a list in the following format:
    [
        {
            "expected landscape and content": "according to the user query, please figure out what kind of landscape and content the user want to visit. If there is any related people, please indicate",
            "expected activities": "according to the user query, please figure out the activities the user want to do. If there is any related people or activities, please indicate" ,
            "expected atmosphere": "according to the user query, please figure out the atmosphere the user want to feel",
        },
        ...
    ]
```

**Confirmed with a schema bug:** the bullet declares `expected atomosphere` (typo, line 27) while the JSON template and the consumer both use `expected atmosphere` (line 35; `SearchEngine.py:120`). The typo only appears in the descriptive bullet so it happens not to break anything — but the field is documented twice under two different names.

Model: `gpt-4o` (`SearchEngine.py:99`). Parsing: `strip("```json\n").strip("```")` then `json.loads`, returning `None` on failure (`:70-78`) — with **no retry and no guard**; `get_cosine_similarity` immediately does `user_input_decomposition[0][...]` (`:118-120`) and will `TypeError` on `None`. In `UGuideRAG.__init__` (`:19-24`) this is papered over by an **infinite retry loop** around the whole retrieval call:
```python
    while True:
      try:
        self.data = self.search_engine.get_cosine_similarity(self.user_input)
        break
      except:
        pass
```
which is a live-lock hazard (an auth failure spins forever).

### 8.2 The embedding calls — three per user, three per POI, one weighted sum

`Code/SearchEngine.py:104-160`. Encoder: `SentenceTransformer('paraphrase-MiniLM-L6-v2')` (`:11`) — **384-dim, local, CPU**. Not OpenAI. (`openai` is imported but used only for the decomposition call.)

User side, `:123-125`:
```python
    user_lc_embeddings = np.array(self.sbert.encode(lc)).reshape(1, -1)
    user_ac_embeddings = np.array(self.sbert.encode(ac)).reshape(1, -1)
    user_at_embeddings = np.array(self.sbert.encode(at)).reshape(1, -1)
```

POI side, `:139-148` — the pre-computed file is a `{name: {dimension: vector}}` dict, three vectors per POI:
```python
        for va_name, va_features_embeddings in all_va_features_embeddings.items():
            lc_embeddings_list.append(np.array(va_features_embeddings['landscape and content']).reshape(1, -1))
            ac_embeddings_list.append(np.array(va_features_embeddings['suitable activities']).reshape(1, -1))
            at_embeddings_list.append(np.array(va_features_embeddings['atmosphere']).reshape(1, -1))
            attraction_names.append(va_name)
        lc_embeddings_matrix = np.vstack(lc_embeddings_list)
        ac_embeddings_matrix = np.vstack(ac_embeddings_list)
        at_embeddings_matrix = np.vstack(at_embeddings_list)
```
Files: `Dataset/Paris/VA_features_embeddings.json` (features) and `Dataset/Paris/VA_desc_embeddings.json` (descriptions) — the latter is **loaded by nothing** in `Code/`. `Dataset/Paris/VA_desc.csv` and `VA_wiki_Paris.csv` are also unread. The only Python files in the repo are the three in `Code/`.

Similarity and the merge, `:151-160`:
```python
        lc_similarity = cosine_similarity(lc_embeddings_matrix, user_lc_embeddings)
        ac_similarity = cosine_similarity(ac_embeddings_matrix, user_ac_embeddings)
        at_similarity = cosine_similarity(at_embeddings_matrix, user_at_embeddings)

        # Compute average similarity
        avg_similarity = 0.6 * lc_similarity.flatten() + 0.5 * ac_similarity.flatten() + 0.5 * at_similarity.flatten()

        va_data['cosine_similarity'] = avg_similarity
        va_df_sorted = va_data.sort_values(by='cosine_similarity', ascending=False).reset_index(drop=True)
```

**The weights are `0.6 / 0.5 / 0.5`, hard-coded, and they do not sum to 1.0** — so the score is an unnormalised 1.6x over-weighting. The comment says "Compute average similarity" but it is a weighted sum. Not configurable, not in a YAML, no ablation.

### 8.3 Does retrieval truly run per-dimension then merges? **No.**

This is the key negative finding, and it is weaker than the framework figure's "dimension-aware retrieval" framing suggests.

- The decomposition returns a **list**, and only `[0]` is read (`SearchEngine.py:118-120`). If the LLM returns three requirement dicts, two are silently discarded.
- The three cosine similarities are computed in **one pass over the same candidate set** and **immediately linearly combined** (`:151-159`). There is **no per-dimension top-k, no per-dimension rank, no per-dimension score normalisation, no per-dimension re-ranking.** The merge is one dot product on a weighted sum.
- There is **no negative/avoid channel at all** — the decomposition prompt has three *positive* fields only (`SearchEngine.py:24-38`). No `avoid`, no `neg`, no subtraction. So "I want X but not Y" degrades to "X, with Y as noise". (The reranker prompt's "Negative Filtering" guideline, §8.4, is the only compensation.)
- The reranker is **one** call over the merged top-50 (`UGuideRAG.py:30-74`, `:103-109`), not three.

Honest description: **three-dimension extraction, three parallel embeddings, one weighted-sum retrieval, one rerank pass.** Not "per-dimension retrieval then merge". `NOT PRESENT IN CODE` as a per-dimension retrieval strategy.

### 8.4 The reranker prompt

`UGuideRAG.py:30-74` (`get_prompt_with_scoring`). A *different* provider: `deepseek-r1-250120` via Volcano Ark `https://ark.cn-beijing.volces.com/api/v3` (`UGuideRAG.py:25-27`, `:91-97`).

```python
    prompt = f"""
        You are an AI travel planning assistant specializing in Paris attractions.

        Your task is to assign a **suitability score** (from 0 to 10) to each of the 50 candidate attractions based on the user's travel preferences.

        ### Scoring Guidelines
        For each attraction, evaluate and assign a **total score** between 0 and 10, considering:
        1. **Content Relevance (0-10)**: How well the attraction matches the user's desired themes, activities, and atmosphere.
        2. **Negative Filtering**: Strongly penalize attractions containing user-prohibited or mismatched elements.
        3. **Do NOT consider coordinates or spatial information.**

        ### Input Data

        【User Preferences】
        {self.user_input}

        【Candidate Attractions】(Each has: id, name, landscape and content, suitable activities, atmosphere)
        {top_50_attractions_list}

        ### Output Format
        Return a single Python dictionary in the following format:

        {{attraction_id_1: score, attraction_id_2: score, ..., attraction_id_50: score}}

        **Requirements**:
        - Only return the dictionary.
        - Scores must be floats from 0 to 10 (inclusive).
        - Do NOT include explanations, rankings, or location data.
        - Do NOT format in Markdown or JSON, use pure Python dictionary syntax.
        """
```

Two design decisions worth copying, both correct:
- **"Do NOT consider coordinates or spatial information."** (guideline 3) — the semantic reranker is deliberately blind to geography so the spatial stage is not contaminated by it. Explicit prompt-level stage separation.
- **Python dict literal parsed with `ast.literal_eval`** (`UGuideRAG.py:105`: `itinerary_dict = ast.literal_eval(itinerary_str)`) — not `json.loads`, and the prompt demands it explicitly. This is *strictly safer* than `json.loads` on LLM output and I have not seen anyone else do it. (In TS the analogue is a real parser, not `JSON.parse`, plus a schema guard — see §9.2 `safeParseLlmJson`.)

The scored field is written back and re-sorted, **replacing** the retrieval score (`UGuideRAG.py:106-109`):
```python
      attractions = self.data.head(50)
      attractions['score']=attractions['id'].map(itinerary_dict)
      sorted_attractions = attractions.sort_values(by='score', ascending=False).reset_index(drop=True)
```
The merged cosine score is **discarded**. And `ast.literal_eval` on a 50-key dict from an R1 reasoning model has **no try/except and no retry** — one stray token and the whole run dies.

### 8.5 SpatialSolver's cluster-aware spatial optimisation — and it is broken as published

`UGuideRAG.py:112-119`:
```python
  def get_ordered_candidates(self):
    attraction_details = self.map_scores_with_attractions()
    SpatialSolver = SpatialSolver(attraction_details,3,10,1000)
    candidates = SpatialSolver.get_candidates()
    ordered_candidates,distance = SpatialSolver.solve_tsp(candidates)
    return ordered_candidates,distance
```
So: `min_clusters_vas=3`, `min_vas=10`, `citywalk_thresh=1000` (**1000 m**, vs `SpatialSolver.__init__`'s own default of 500 and `get_clusters`'s default of 1000).

**The clustering is the same maximum-clique-peel algorithm as ITINERA — copy-pasted.** `Code/SpatialSolver.py:13-48` is `get_clusters`, and comparing to `itinera/model/spatial.py:50-87` they are the same function with `poi_idlist`->`va_data` and a different `thresh` default. Both do `cdist` + `fill_diagonal(thresh+100)` + self-loops + `while G.number_of_nodes() > 0: cliques = list(nx.find_cliques(G))` + take the longest + `remove_nodes_from`. **This is direct evidence that ITINERA's clustering came from the same lineage as UGuideRAG's.**

**But `SpatialSolver.py` does not import `networkx`, and imports only the cdist *function* from scipy.** Verified — the file's entire import block is lines 1-3:
```python
import pandas as pd
import numpy as np
from scipy.spatial.distance import cdist
```
while the body uses `scipy.spatial.distance.cdist(...)` (line 25, module-qualified — the module object is never bound) and `nx.Graph()` (line 28) and `nx.find_cliques` (line 42). `networkx` **is** in `requirements.txt` but never imported. So:

> **`get_clusters()` raises `NameError: name 'scipy' is not defined` on line 25. `get_candidates()` calls it on line 69 and therefore cannot complete. `get_ordered_candidates()` is not runnable, and neither is `route_planner()` which calls it.** `NOT PRESENT IN CODE` as a working implementation. (It is a one-line missing import, not a missing dependency.)

**The candidate-selection loop** (`SpatialSolver.py:50-93`) — grow the pool until enough POIs sit in "big enough" clusters:
```python
      initial_count = self.min_vas
      initial_data = self.data.iloc[:initial_count].copy()

      current_cluster = self.get_clusters(initial_data, self.citywalk_thresh)
      candidates = pd.DataFrame(columns=self.data.columns)

      while True:
          valid_va_count = 0
          for cluster in current_cluster:
              if len(cluster) >= self.min_clusters_vas:
                valid_va_count += len(cluster)

          if valid_va_count >= self.min_vas:
              break

          initial_count += 1
          initial_data = self.data.iloc[:initial_count].copy()
          current_cluster = self.get_clusters(initial_data, self.citywalk_thresh)

      for cluster in current_cluster:
          if len(cluster) >= self.min_clusters_vas:
              candidates = pd.concat([candidates, self.data.loc[list(cluster)]])
```
i.e. a **linear scan `N = min_vas, min_vas+1, ...` re-clustering the whole prefix at each step** until >= `min_vas` POIs are covered by clusters of size >= 3. This is `O(N^2)` `find_cliques` calls and has **no iteration cap and no guaranteed termination** — if the POI set is spatially diffuse, `valid_va_count` can stay below `min_vas` forever.

**The routing is a from-scratch simulated annealing with random-swap moves** (`SpatialSolver.py:96-148`) — a *different* SA from `python_tsp`'s:
```python
      temp = initial_temp
      while temp > Tmin:
          # Randomly swap two points
          i, j = np.random.randint(0, num_pois, size=2)
          new_solution = np.copy(current_solution)
          new_solution[i], new_solution[j] = new_solution[j], new_solution[i]

          new_distance = total_distance(new_solution)

          # Accept new solution based on energy difference and probability
          if new_distance < current_distance or np.exp((current_distance - new_distance) / temp) > np.random.rand():
              current_solution, current_distance = new_solution, new_distance

              if new_distance < best_distance:
                  best_solution, best_distance = new_solution, new_distance

          temp *= cooling_rate  # Gradually reduce temperature
```
Defaults `initial_temp=5000, cooling_rate=0.99, Tmin=1e-13` -> ~3007 iterations. Two flaws: (a) the temperature is in *absolute metres* (`5000` m), so it is meaningless across cities; (b) the only move is a **uniformly random 2-swap with no spatial locality** — no segment reversal, no insertion, no Or-opt. For a 10-POI open path, random 2-swap SA converges very poorly compared to 2-opt. The single worst move type for a path problem.

**Metrics.** `solve_tsp` returns a Euclidean total (`SpatialSolver.py:148`) but `calculate_straightline_distance` recomputes a *geodesic* total in metres over the same route (`UGuideRAG.py:135-145`):
```python
    total_distance = 0
    previous_coordinates = None
    for coordinates in attraction_coordinates:
        if previous_coordinates:
            total_distance += geodesic(previous_coordinates, coordinates).kilometers*1000
        previous_coordinates = coordinates
    return total_distance
```
`route_planner` **overwrites** the solver's distance with this geodesic one (`UGuideRAG.py:165`: `distance = self.calculate_straightline_distance(locations)`) and then returns only the `map` object — the recomputed distance is assigned to a local and never returned. So the "optimised" objective (Euclidean in projected metres) and the "reported" number (geodesic km) are different metrics, and the reported one is discarded anyway.

**Data coordinates:** `Dataset/Paris/VA_features.csv` header `name,landscape and content,suitable activities,atmosphere,latitude,longitude,x,y,id`, sample `x=656504.13, y=6862194.85` — again **EPSG:3857 metres**, so `citywalk_thresh=1000` is 1 km. `pyproj` is in `requirements.txt` but no code uses it.

---

## 9. MINIMAL TS IMPLEMENTATION

The smallest set of pure-TypeScript algorithms that reproduces the valuable behaviour of all seven repos. No Z3, no OR-Tools, no numpy, no Python. ~1200 lines of implementation + tests.

### 9.1 What to take, what to drop

| Take | From | Why |
|---|---|---|
| `TIME2NUM` hours->(clusters, POIs, radius) table | itinera.py:25 | the only empirically-grounded budget->scale mapping in the corpus |
| max-clique-peel clustering on a radius graph | itinera spatial.py:50-87; uguiderag SpatialSolver.py:13-48 | diameter-bounded, deterministic, no k needed, no empty-cluster problem |
| sum-score cluster ranking + top-2 stochastic pick | itinera spatial.py:246,292 + funcs.py:266-291 | 12 lines, explores at least one near-optimal cluster |
| must-see "one clique must contain all" citywalk test | itinera spatial.py:255-263 | the walking-feasibility predicate, 8 lines |
| score constants 1000 / 900 / 10 | itinera spatial.py:238; funcs.py:144 | makes downsampling provably keep must-sees |
| sum-of-cosines across decomposed requests; minus-cosine for `avoid` | itinera.py:237; search.py:113-117 | the entire re-merge rule, 4 lines |
| 1.5-sigma radial outlier prune | itinera spatial.py:24-48 | 12 lines, kills the far-flung POI |
| heaviest-edge rotation of the cluster tour | itinera.py:288-295 | free 2-opt-open on the cluster TSP |
| closest-pair cluster stitching | itinera spatial.py:204 + funcs.py:294-317 | 6 lines, exact |
| `AddCircuit` semantics as **cheapest-insertion + 2-opt + Or-opt** | floattrip optimizer.py:380-400 | same semantics, ~80 lines, no solver |
| scalarised integer objective, rewards/penalties split, scale 6000 | floattrip scoring.py + balanced-v1.yaml | auditable, exact in integers, offline re-derivation works |
| independent validator + objective-delta check | floattrip optimizer.py:705-812, 780-785 | the pattern that makes an LLM-in-the-loop system trustworthy |
| three-tier relaxation ladder (strict -> relaxed-min -> greedy) | floattrip optimizer.py:320-330 | the honest, working alternative to unsat cores |
| adaptive penalty controller (bang-bang on a feasibility ratio) | pyvrp PenaltyManager.py:181-231 | the only real anti-local-optima mechanism in the corpus |
| LAHC acceptance + restart-from-best | pyvrp IteratedLocalSearch.py:255-278 | 15 lines, beats hill-climbing |
| `ast.literal_eval`-style safe parsing of LLM output | uguiderag UGuideRAG.py:105 | parse untrusted output with a real parser, not `JSON.parse` |
| prompt-level "ignore coordinates in the reranker" | uguiderag UGuideRAG.py:57 | stage separation, free |
| `unsat_core()` + `assert_and_track` as *diagnostics you log* | tripweaver prompts/solve_5.txt:11-17 | fine to log; **not** a driver |

| Drop | Why |
|---|---|
| PuLP/CBC exact open TSP | n <= 9; Held-Karp or Or-opt is 5 lines of TS |
| Z3 `Optimize` with mixed `minimize` + `maximize` | tripweaver L405,502,590 — lexicographic priority makes the penalty term *lowest* priority, silently defeating the relaxation. Scalarise. |
| Z3 `Array` + `Select` city inventories | tripweaver L182-206 — works, but a `Map<number,number>` + a loop is clearer |
| pairwise O(n^2) no-overlap | tripweaver L600-618 — 1176 clauses for a 7-day trip |
| random-swap-only SA | uguiderag SpatialSolver.py:130-133 — worst move for a path problem |
| non-normalised weighted cosine sum (0.6/0.5/0.5) | uguiderag SearchEngine.py:156 — divide by the weight sum |
| discarding the RAG score before the objective | routemind ortools_optimizer.py:155 |
| `find_clusters_containing_all_elements` | funcs.py:321-340 — name and behaviour disagree (returns "any") |
| unscaled 1000 m fallback threshold | itinera.py:35, spatial.py:270 |
| unbounded linear scan / no termination guarantee | uguiderag SpatialSolver.py:73-84 |
| SA temperature in absolute metres | uguiderag SpatialSolver.py:127 |
| `while True: try/except: pass` retry | uguiderag UGuideRAG.py:19-24 — live-lock on a permanent error |

### 9.2 Data structures

```ts
// ============================================================================
// 1. PROBLEM — what the traveller said, after one LLM decomposition call
// ============================================================================

export type Axis = 'location' | 'itinerary' | 'starting point' | 'ending point';
export type Polarity = 'require' | 'prefer' | 'avoid' | 'fact';   // floattrip/chat/models.py:23

export interface DecomposedRequest {
  pos: string;                 // want  (no negation allowed)
  neg: string | null;          // avoid (negation target extracted OUT of pos)
  mustsee: boolean;            // specificity: is `pos` a named place?
  type: Axis;                  // granularity
}

export interface Traveller {
  hours: number;               // 1..8
  budgetMinor: number;         // integer minor units, e.g. cents
  currency: string;
  groupSize: number;
  accessNeeds: AccessNeed[];   // wheelchair | stroller | lowStairs | hearingLoop | none
  maxSpendPerPersonMinor?: number;   // undefined = no money ceiling
  startClock?: number;         // minutes from midnight; default 9*60
  endClock?: number;           // default 21*60
  requests: DecomposedRequest[];
  startPoiId?: string;         // from type === 'starting point'
  endPoiId?: string;           // from type === 'ending point'
}

export interface AccessNeed {
  kind: 'wheelchair' | 'stroller' | 'lowStairs' | 'hearingLoop';
  // precomputed, so the filter is a pure predicate with no geo lookups
  ok: boolean;
}

// ============================================================================
// 2. CATALOGUE — the POI table. ONE row, ONE embedding, all attributes.
//    (contrast: tripweaver has separate restaurant/attraction/accommodation lists
//     and cannot reason about price or category inside the solver)
// ============================================================================

export interface Poi {
  id: string;
  name: string;
  /** Web-Mercator EPSG:3857 metres. All distances below are Euclidean on this. */
  x: number; y: number;
  /** OPENSAT / daylight minutes, already normalised for the visit date. */
  openMin: number; closeMin: number;
  /** typical on-site minutes */
  durationMin: number;
  /** per-person price, minor units */
  priceMinor: number;
  rating: number;              // 0..5
  category: string;            // 'museum' | 'park' | 'restaurant' | ...
  tags: string[];              // 'outdoor', 'high_fatigue', 'wheelchair_accessible', ...
  /** normalise(embed(`${name}\n${category}\n${tags.join(',')}\n${desc}`)) */
  emb: Float32Array;
  /** optional per-dimension embeddings, only if you want UGuideRAG's 3 axes */
  embByAxis?: { landscape: Float32Array; activities: Float32Array; atmosphere: Float32Array };
}

// ============================================================================
// 3. SCORING — a frozen, versioned, single-scalar objective.
//    Dividing all weights by `scale` keeps the value in float64 and the
//    audit exact to 1e-6. (floattrip needed scale=6000 because CP-SAT is
//     integer-only; we have no such constraint.)
// ============================================================================

export interface ScoreProfile {
  version: string;
  rewards: {
    relevance: number;        // cosine / fused score
    rating: number;
    categoryDiversity: number;
    dailyTargetFill: number;
  };
  penalties: {
    perKm: number;
    crossClusterArc: number;
    waitingPerMin: number;
    dailyLoadImbalance: number;
    timeWindowMiss: number;   // big: quasi-hard
    accessNeedMiss: number;   // bigger: effectively hard
  };
}
export const BALANCED_V1: ScoreProfile = {
  version: 'balanced-v1',
  rewards:   { relevance: 1.5, rating: 1.0, categoryDiversity: 0.5, dailyTargetFill: 0.8 },
  penalties: { perKm: 0.12, crossClusterArc: 0.35, waitingPerMin: 0.25 / 60,
               dailyLoadImbalance: 0.30 / 60, timeWindowMiss: 4.0, accessNeedMiss: 100.0 },
};

// ============================================================================
// 4. CLUSTERING — the ITINERA/UGuideRAG radius graph + max-clique peel.
// ============================================================================

export interface Cluster { ids: string[]; cx: number; cy: number; }

// ============================================================================
// 5. PLAN — the output
// ============================================================================

export interface Stop {
  poiId: string; day: number; startMin: number; endMin: number;
  distFromPrevM: number;
}
export interface Day { day: number; stopIds: string[]; loadMin: number; }
export interface Plan {
  days: Day[];
  stops: Stop[];
  objective: number;
  breakdown: { component: string; raw: number; weight: number; contribution: number }[];
  diagnostics: {
    tier: 'greedy' | 'insert' | 'ils';      // relaxation tier actually used
    relaxed: RelaxedConstraint[];            // which soft constraints were dropped
    iterations: number;
    elapsedMs: number;
    seed: number;
  };
  violations: Violation[];
}
export type RelaxedConstraint = 'DAILY_MIN' | 'WAITING_PENALTY' | 'CROSS_CLUSTER_ARC' | 'DIVERSITY';
export interface Violation { code: string; message: string; day?: number; poiId?: string; }

// ============================================================================
// 6. HELPERS — a seeded RNG so the whole engine is reproducible.
//    ITINERA has no seed anywhere; that is a bug, not a style.
// ============================================================================

export interface Rng { (): number; int(n: number): number; pick<T>(a: readonly T[]): T; }
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  const f = () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
                    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return Object.assign(f, { int: (n) => Math.floor(f() * n), pick: (arr) => arr[Math.floor(f() * arr.length)] });
}
```

### 9.3 The `TIME2NUM` table, generalised

`itinera.py:25` is linear in hours. Generalise to *available minutes* rather than hours, and make the radius come from a walking-speed budget rather than a magic metre constant:

```ts
// itinera/model/itinera.py:25  (verbatim shape, extended to minute resolution)
const TIME2NUM: Record<number, [clusters: number, pois: number, radiusM: number]> = {
  1: [1,  3, 2000], 2: [1,  5, 3000], 3: [2,  7, 4000], 4: [2,  9, 5000],
  5: [3, 11, 6000], 6: [3, 13, 7000], 7: [4, 15, 8000], 8: [4, 17, 9000],
};

export interface Budget { clusters: number; pois: number; radiusM: number; minPerDay: number; maxPerDay: number; }

/** ATHITI: derive the spatial budget from minutes, group size and mobility. */
export function budgetFor(t: Traveller): Budget {
  const h = Math.min(8, Math.max(1, Math.round(t.hours)));
  const [k, n, r] = TIME2NUM[h];
  // a cluster must be walkable *for this group*, at this pace
  const WALK_M_PER_MIN = 75;                                   // ~4.5 km/h
  const accessible = t.accessNeeds.some(a => a.kind === 'wheelchair' || a.kind === 'stroller');
  const radiusM = accessible ? Math.min(r, 700) : r;            // short leash for wheels/strollers
  // per-stop budget: leave 2 x 25 min for the two meal windows
  const usable = (t.endClock ?? 21 * 60) - (t.startClock ?? 9 * 60) - 50;
  const maxPerDay = Math.max(1, Math.min(n / k, Math.floor(usable / 90)));
  const minPerDay  = Math.max(1, Math.round(maxPerDay * 0.6));
  return { clusters: k, pois: n, radiusM, minPerDay, maxPerDay,
           // sanity: a walking day cannot exceed radiusM*2 of travel
           walkBudgetM: radiusM * 2, walkMPerMin: WALK_M_PER_MIN };
}
```

### 9.4 STAGE A — filtering (physically impossible) and ranking

Order matters: **filter first, embed never on a filtered-out POI.** Four predicates, all pure.

```ts
const d2 = (a: Poi, b: Poi) => Math.hypot(a.x - b.x, a.y - b.y);
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);

// ---------------------------------------------------------------- FILTER 1
// Hard accessibility + availability. This is ATHITI's "physically impossible"
// filter. NEVER let the LLM or the ranker see a POI that failed it.
function feasible(poi: Poi, t: Traveller): boolean {
  if (t.accessNeeds.length && !t.accessNeeds.every(n => n.ok || !poi.tags.includes(n.kind))) return false;
  if (poi.durationMin <= 0) return false;
  if (poi.openMin >= poi.closeMin) return false;                 // never open
  if (poi.priceMinor > 0 && t.maxSpendPerPersonMinor != null &&
      poi.priceMinor > t.maxSpendPerPersonMinor) return false;   // budget ceiling
  if (t.groupSize > 1 && poi.tags.includes('solo_only')) return false;
  return true;
}

// ---------------------------------------------------------------- FILTER 2
// itinera/model/spatial.py:24-48  (1.5-sigma radial outlier prune, verbatim shape)
function pruneOutliers(cands: Poi[]): Poi[] {
  if (cands.length <= 2) return cands;
  const cx = mean(cands.map(p => p.x)), cy = mean(cands.map(p => p.y));
  const dists = cands.map(p => Math.hypot(p.x - cx, p.y - cy));
  const m = mean(dists), s = Math.sqrt(mean(dists.map(d => (d - m) ** 2)));
  const keep = cands.filter((_, i) => Math.abs(dists[i] - m) <= 1.5 * s);
  return keep.length >= 2 ? keep : cands;   // never prune to nothing
}

// ---------------------------------------------------------------- RANK
// itinera/model/itinera.py:235-241 + model/search.py:113-117.
//   score = SUM over decomposed requests of (+cos(pos_r) - cos(neg_r)), mean-recentred.
//   RouteMind's mistake (ortools_optimizer.py:155) is to drop this entirely; do not.
function rank(cands: Poi[], t: Traveller, embed: (s: string) => Float32Array): Map<string, number> {
  const acc = new Float64Array(cands.length);                 // running sum, indexed like `cands`
  for (const r of t.requests) {
    if (r.type === 'itinerary') continue;                      // itinera: itinerary reqs get no POI search
    const pos = cosine(embed(r.pos), cands);
    const m = mean(pos);
    if (r.neg) {
      const neg = cosine(embed(r.neg), cands);
      for (let i = 0; i < cands.length; i++) acc[i] += (pos[i] - neg[i]) - m;   // model/search.py:113-117
    } else {
      for (let i = 0; i < cands.length; i++) acc[i] += pos[i] - m;
    }
  }
  // named places get the itinera magic weights: 1000 must-see, 10 pseudo-must-see
  // (itinera/model/spatial.py:230-242). The 900 threshold in downsampling sits
  // between them, which is what makes must-sees provably survive sampling.
  for (const r of t.requests) {
    if (!r.mustsee) continue;
    cands.forEach((p, i) => { if (fuzzy(p.name, r.pos) > 91) acc[i] = 1000; });
  }
  return new Map(cands.map((p, i) => [p.id, acc[i]]));
}
```
Cluster selection then re-uses that one score map (§9.5), exactly as ITINERA does — no second ranking pass.

### 9.5 CLUSTER-THEN-ROUTE, step by step

**Step 1 — cluster. Maximum-clique peel on a radius graph.** This is the one algorithm we copy verbatim in spirit from `itinera/model/spatial.py:50-87`. Bron-Kerbosch with pivoting, peel the largest clique, repeat. ~45 lines.

```ts
// Bron-Kerbosch with pivoting. Returns ALL maximal cliques of the threshold graph.
function findCliques(nodes: number[][], thr: number): number[][] {
  const n = nodes.length;
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      if (Math.hypot(nodes[i][0] - nodes[j][0], nodes[i][1] - nodes[j][1]) < thr) {  // strict <
        adj[i].push(j); adj[j].push(i);
      }

  const out: number[][] = [];

  // Standard Bron-Kerbosch with pivoting. r = the growing clique, x = the
  // "already reported" frontier. Reporting happens when BOTH are empty.
  const bk = (r: number[], x: number[]): void => {
    if (r.length === 0) { if (x.length === 0) return; out.push([]); return; }
    // pivot: the vertex in R u X with the most neighbours inside R
    let pivot = -1, best = -1;
    for (const u of [...r, ...x]) {
      const deg = r.reduce((s, v) => s + (adj[u].includes(v) ? 1 : 0), 0);
      if (deg > best) { best = deg; pivot = u; }
    }
    // only branch on vertices NOT adjacent to the pivot -- that is the pruning
    const cand = r.filter(v => pivot < 0 || !adj[pivot].includes(v));
    for (const v of cand) {
      bk([...r, v], x.filter(u => adj[v].includes(u)));
      r.pop();
      x.push(v);
    }
  };
  // Seed per node, mirroring itinera's G.add_edge(i, i) self-loop so that no
  // node is ever invisible to find_cliques. j > i keeps each edge once.
  for (let i = 0; i < n; i++) bk([i], adj[i].filter(j => j > i));
  return out.filter(c => c.length > 0);
}

/** itinera/model/spatial.py:50-87  ->  list of disjoint maximal cliques, largest first. */
export function cliqueCluster(pts: { id: string; x: number; y: number }[], thr: number): Cluster[] {
  if (pts.length === 0) return [];
  const coords = pts.map(p => [p.x, p.y] as [number, number]);
  const live = new Set(pts.map(p => p.id));
  const cliques = findCliques(coords, thr);
  const clusters: Cluster[] = [];
  while (live.size > 0) {
    let best: string[] | null = null;
    for (const c of cliques) {
      const ids = c.map(i => pts[i].id).filter(id => live.has(id));
      if (ids.length > 0 && (!best || ids.length > best.length)) best = ids;
    }
    if (!best) break;                                   // safety: never loop forever
    for (const id of best) live.delete(id);
    clusters.push({ ids: best, cx: mean(best.map(i => pts.find(p => p.id === i)!.x)),
                              cy: mean(best.map(i => pts.find(p => p.id === i)!.y)) });
  }
  return clusters;                                      // already largest-first
}
```
**Why peel-largest-first and not single-linkage or k-means:** a clique is a *diameter*-bounded set (every pair within `thr`), so "everything in this cluster is walkable from everything else" is a guarantee, not a hope. And `k` falls out of the data, so you never get an empty cluster or a `k` bigger than `n`. Cost is Bron-Kerbosch's worst case, which is irrelevant at n ≈ 40.

**Step 2 — select clusters greedily with the sum-score rule + top-2 random pick.** `itinera/model/spatial.py:244-263, 290-307` + `utils/funcs.py:266-291`:

```ts
function selectClusters(
  all: Cluster[], score: Map<string, number>, b: Budget, mustSee: string[], rng: Rng,
): { chosen: Cluster[]; walkable: boolean } {
  const sum = (c: Cluster) => c.ids.reduce((s, id) => s + (score.get(id) ?? 0), 0);

  // --- "can this be a pure walking day?"  (itinera spatial.py:255-263) ---
  const top2 = [...all].sort((x, y) => sum(y) - sum(x)).slice(0, 2);
  if (top2.length) {
    const pick = rng.pick(top2);
    if (pick.ids.length >= b.pois - 2 && mustSee.every(id => pick.ids.includes(id))) {
      return { chosen: [pick], walkable: true };            // one tight, fully-covered neighbourhood
    }
  }
  // --- general path: harvest until BOTH counters are met (itinera spatial.py:290-307) ---
  const rest = [...all];
  const chosen: Cluster[] = [];
  const seen = new Set<string>();
  const need = new Set(mustSee);
  while (rest.length) {
    const ranked = rest.map((c, i) => [i, sum(c)] as const).sort((a, b2) => b2[1] - a[1]);
    const candIdx = ranked.slice(0, Math.min(2, ranked.length)).map(([i]) => i);   // k = 2, always
    if (!candIdx.length) break;
    const c = rest.splice(rng.pick(candIdx), 1)[0];
    const fresh = c.ids.filter(id => !seen.has(id));
    if (fresh.length) { chosen.push(c); fresh.forEach(id => seen.add(id)); need.delete(...fresh); }
    if (chosen.length > b.clusters && seen.size >= b.pois && need.size === 0) break;
  }
  // guarantee every named place is in the candidate set, even if its cluster lost
  for (const id of mustSee) if (!seen.has(id)) { seen.add(id); chosen.push({ ids: [id], cx: 0, cy: 0 }); }
  return { chosen, walkable: false };
}
```
Two deliberate deviations from ITINERA, both bug fixes: (a) no `while(true)` — every path is bounded by `rest.length`; (b) `find_clusters_containing_all_elements` is replaced by an explicit `need` set (itinera funcs.py:321-340 returns "any" while its name and docstring say "all").

**Step 3 — order the clusters. TSP on centroids, then open the heaviest edge.** `itinera/model/itinera.py:283-295` + `model/spatial.py:144-168` (which uses `python_tsp` SA; we use 2-opt, which is better and 15 lines).

```ts
function openPathTsp<D>(idx: (i: number) => D, n: number, dist: (a: D, b: D) => number): number[] {
  if (n <= 2) return [...Array(n).keys()];
  let tour = nearestNeighbour(idx, n, dist);
  for (let pass = 0; pass < 200; pass++) {                 // 2-opt until no improvement
    let improved = false;
    for (let i = 0; i < tour.length - 2; i++)
      for (let k = i + 2; k < tour.length; k++) {
        if (i === 0 && k === tour.length - 1) continue;    // skip the wrap edge
        const a = idx(tour[i]), b = idx(tour[i + 1]), c = idx(tour[k]), d = idx(tour[k + 1] ?? tour[0]);
        if (dist(a, c) + dist(b, d) < dist(a, b) + dist(c, d) - 1e-9) {
          tour = [...tour.slice(0, i + 1), ...tour.slice(i + 1, k + 1).reverse(), ...tour.slice(k + 1)];
          improved = true;
        }
      }
    if (!improved) break;
  }
  // itinera/model/itinera.py:288-295 -- rotate so the heaviest CLOSED-tour edge becomes the open end
  const closed = [...tour, tour[0]];
  let worst = 0, worstD = -1;
  for (let i = 0; i < closed.length - 1; i++) {
    const dd = dist(idx(closed[i]), idx(closed[i + 1]));
    if (dd > worstD) { worstD = dd; worst = i + 1; }
  }
  return [...tour.slice(worst), ...tour.slice(0, worst)];
}
```
(Above is the centroid TSP only; the same `openPathTsp` is reused verbatim for the per-day sequencing in §9.6 — one routine, two scales. That reuse is the actual elegance of ITINERA's `get_tsp_order`, and it costs nothing.)

**Step 4 — stitch consecutive clusters at their closest pair.** `itinera/model/spatial.py:188-208` + `utils/funcs.py:294-317`:

```ts
function stitch(order: Cluster[], byId: Map<string, Poi>): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i + 1 < order.length; i++) {
    let best: [string, string] | null = null, bd = Infinity;
    for (const a of order[i].ids) for (const b of order[i + 1].ids) {
      const d = d2(byId.get(a)!, byId.get(b)!);
      if (d < bd) { bd = d; best = [a, b]; }
    }
    if (best) out.push(best);
  }
  return out;
}
```
Exact, O(|A|·|B|), and the `bd` is also a free feasibility signal: if any stitch exceeds the day's travel budget, the cluster order is wrong and you should try the next-best cluster permutation (this is the check ITINERA never does).

**Step 5 — orient each interior cluster so the two bridge POIs are its endpoints.** `itinera/model/itinera.py:450-469` did this with a PuLP exact open-TSP. Held-Karp is enough at these sizes (n ≤ 9) and is 12 lines:

```ts
/** Exact shortest open path from `s` to `e` visiting every node (Held-Karp, n <= ~12). */
function heldKarpOpen(nodes: Poi[], s: number, e: number): { order: number[]; len: number } | null {
  const n = nodes.length;
  if (n <= 2) return { order: [...Array(n).keys()], len: d2(nodes[0], nodes[n - 1]) };
  const mid = [...Array(n).keys()].filter(i => i !== s && i !== e);
  const m = mid.length;
  const FULL = 1 << m;
  const dp = new Float64Array(FULL * m).fill(Infinity);
  const par = new Int32Array(FULL * m).fill(-1);
  mid.forEach((v, j) => { dp[(1 << j) * m + j] = d2(nodes[s], nodes[v]); });
  for (let mask = 0; mask < FULL; mask++)
    for (let j = 0; j < m; j++) {
      if (!(mask & (1 << j))) continue;
      const cur = dp[mask * m + j]; if (!isFinite(cur)) continue;
      for (let k = 0; k < m; k++) {
        if (mask & (1 << k)) continue;
        const nm = mask | (1 << k);
        const alt = cur + d2(nodes[mid[j]], nodes[mid[k]]);
        if (alt < dp[nm * m + k]) { dp[nm * m + k] = alt; par[nm * m + k] = j; }
      }
    }
  let best = Infinity, bj = -1;
  for (let j = 0; j < m; j++) { const v = dp[(FULL - 1) * m + j] + d2(nodes[mid[j]], nodes[e]); if (v < best) { best = v; bj = j; } }
  if (bj < 0) return null;
  const order = [s]; let mask = FULL - 1, j = bj;
  while (j >= 0) { order.push(mid[j]); const p = par[mask * m + j]; mask &= ~(1 << j); j = p; }
  order.reverse(); order.push(e);
  return { order, len: best };
}
```
First and last clusters: iterate the *cycle* of the 2-opt tour and pick the rotation that starts (resp. ends) at the bridge POI — this is exactly what `itinera.py:437-444` does with a bare rotation, and it is correct for the last cluster. For the first cluster you must try **all** rotations × 2 directions and take the min; ITINERA builds an LLM prompt for this (`all_en_prompts.py:86`) and then throws it away (`itinera.py:425`) — just brute-force it, `k ≤ 17` so it is 34 evaluations.

### 9.6 THE PACKER — replacement for the CP-SAT model

Goal: replace `floattrip/optimizer.py:332-601` with ~180 lines of TS that satisfy the same hard constraints and optimise the same scalarised objective. Three tiers, mirroring the `AddCircuit` semantics.

```ts
// ---------------------------------------------------------------------------
// TIER 0 — greedy construction (floattrip _fallback, optimizer.py:603-675)
//   least-loaded day, tie-broken by mean distance to that day's POIs
// ---------------------------------------------------------------------------
function assignToDays(cands: Poi[], b: Budget, score: Map<string, number>, t: Traveller): Poi[][] {
  const days: Poi[][] = Array.from({ length: b.clusters }, () => []);
  const ordered = [...cands].sort((p, q) => {
    const mp = t.requests.some(r => r.mustsee && fuzzy(p.name, r.pos) > 91) ? 1 : 0;
    const mq = t.requests.some(r => r.mustsee && fuzzy(q.name, r.pos) > 91) ? 1 : 0;
    if (mp !== mq) return mq - mp;                        // must-sees first
    const sp = (score.get(p.id) ?? 0) + 0.2 * p.rating;
    const sq = (score.get(q.id) ?? 0) + 0.2 * q.rating;
    return sq - sp || p.id.localeCompare(q.id);           // deterministic tiebreak
  });
  for (const p of ordered) {
    const free = days.filter(d => d.length < b.maxPerDay);
    if (!free.length) break;
    const day = free.sort((A, B) =>
      (A.length - B.length) ||
      (mean(A.map(x => d2(p, x))) - mean(B.map(x => d2(p, x)))) ||
      (days.indexOf(A) - days.indexOf(B)))[0];
    day.push(p);
  }
  return days;
}

// ---------------------------------------------------------------------------
// EARLIEST-FEASIBLE SCHEDULE — floattrip/optimizer.py:207-225, verbatim shape.
//   Forward greedy; returns null the moment any window is violated.
//   This is the ONLY time-feasibility oracle. No solver needed: for a fixed
//   order, earliest-start is optimal and monotone.
// ---------------------------------------------------------------------------
function earliestSchedule(order: Poi[], t: Traveller, dayStart: number): [number, number][] | null {
  const sched: [number, number][] = [];
  let cursor = t.startClock ?? 9 * 60;
  for (const p of order) {
    const lo = Math.max(p.openMin, cursor);
    const hi = p.closeMin - p.durationMin;
    if (lo > hi) return null;
    const s = lo, e = s + p.durationMin;
    if (e > (t.endClock ?? 21 * 60)) return null;
    sched.push([s, e]);
    cursor = e + TRANSFER_MIN;                             // 20, floattrip optimizer.py:29
  }
  return sched;
}
```

Then the insertion + local search that carries the load. `AddCircuit` does assignment + sequencing + subtour-elimination at once; the standard decomposition is **cheapest-insertion for assignment, then 2-opt/Or-opt for sequencing**, plus a repair pass for the constraints 2-opt cannot see (time windows, must-visit, precedence).

```ts
// ---------------------------------------------------------------------------
// TIER 1 — Regret-2 cheapest insertion, then 2-opt + Or-opt, then repair.
//   This is the AddCircuit equivalent. Same feasible set, no solver.
// ---------------------------------------------------------------------------
interface Ctx { b: Budget; t: Traveller; prof: ScoreProfile; clusters: Map<string, number>;
                score: Map<string, number>; relaxed: Set<RelaxedConstraint>; }

function pathCost(order: Poi[], c: Ctx): number {
  if (order.length === 0) return 0;
  let cst = 0;
  for (let i = 0; i < order.length; i++) {
    const p = order[i];
    cst += c.prof.rewards.relevance * (c.score.get(p.id) ?? 0);
    cst += c.prof.rewards.rating * (p.rating / 5);
    cst += c.prof.penalties.timeWindowMiss * (p.durationMin > p.closeMin - p.openMin ? 1 : 0);
    cst += c.prof.penalties.accessNeedMiss * p.tags.filter(tg =>
      c.t.accessNeeds.some(a => a.kind === tg)).length;
    if (i > 0) {
      const prev = order[i - 1], d = d2(prev, p) / 1000;
      cst += c.prof.penalties.perKm * d;
      if (c.clusters.get(prev.id) !== c.clusters.get(p.id) && !c.relaxed.has('CROSS_CLUSTER_ARC'))
        cst += c.prof.penalties.crossClusterArc;
    }
  }
  return cst;
}

/**
 * Feasibility repair by ejection chains. While the day is infeasible, pick the
 * POI whose REMOVAL (or repositioning) most improves hard feasibility, drop it,
 * and park it on the least-loaded other day. Bounded; never loops forever.
 * This is what replaces every CP-SAT hard constraint that 2-opt cannot express.
 */
function repairDay(order: Poi[], c: Ctx, spare: Poi[][]): Poi[] {
  const isMustSee = (p: Poi) => c.t.requests.some(r => r.mustsee && fuzzy(p.name, r.pos) > 91);
  const ok = (o: Poi[]) => earliestSchedule(o, c.t, 0) !== null && satisfiesDay(o, c);
  const hardViolations = (o: Poi[]) =>
      (earliestSchedule(o, c.t, 0) === null ? 1000 : 0)      // any window break is fatal
    + (o.length < c.b.minPerDay ? 10 - o.length : 0)
    + o.filter(p => !isMustSee(p) && (p.durationMin > p.closeMin - p.openMin)).length
    + o.reduce((s, p, i) => s + orderIndex(o, p, beforeOf(p, c)) < 0 ? 1 : 0, 0);

  let cur = [...order];
  for (let guard = 0; guard < 200 && !ok(cur); guard++) {
    // 1. cheapest ejection: try removing each non-must-see POI
    let bestIdx = -1, bestV = Infinity;
    for (let i = 0; i < cur.length; i++) {
      if (isMustSee(cur[i])) continue;
      const v = hardViolations(cur.filter((_, k) => k !== i));
      if (v < bestV) { bestV = v; bestIdx = i; }
    }
    // 2. if no ejection helps, try relocating one POI inside the day
    if (bestIdx < 0 || bestV >= hardViolations(cur)) {
      outer:
      for (let i = 0; i < cur.length; i++) {
        if (isMustSee(cur[i])) continue;
        const rest = cur.filter((_, k) => k !== i);
        for (let j = 0; j <= rest.length; j++) {
          const alt = [...rest.slice(0, j), cur[i], ...rest.slice(j)];
          if (hardViolations(alt) < hardViolations(cur)) { cur = alt; continue outer; }
        }
      }
      return cur;                                  // no local improvement left -> let validate() report
    }
    const [victim] = cur.splice(bestIdx, 1);
    // 3. park the victim on the least-loaded other day that can still take it
    const target = spare.filter(d => d.length < c.b.maxPerDay)
                         .sort((A, B) => A.length - B.length)[0];
    if (target) target.push(victim);
  }
  return cur;
}
```

`repairDay` is the one routine with real heuristic freedom, so it is given as working code rather than a sketch — but the part that actually matters is the contract it must uphold, which is small:

**`satisfiesDay(order, c)` must check, in this order** (every one of these is a hard constraint in `floattrip/optimizer.py:374-534`):
1. `order.length` within `[minPerDay, maxPerDay]` (`:374-377`).
2. `earliestSchedule(order) !== null` (`:408-420`) — covers opening hours, closing hours, day end, and the 20-min transfer.
3. No duplicate POI (`:736-737`).
4. `must_be_first` / `must_be_last` at the ends (`:402-406`).
5. For each `before_poi_names` edge: `index(i) < index(j)` **on the same day**, or `day(i) < day(j)` (`:492-500`, `:524-534`).
6. Budget: cumulative `priceMinor * groupSize` across the whole plan `<= budgetMinor` (floattrip does this per-day with a 1.2x fudge, `ortools_optimizer.py:103`; do it exactly).
7. Accessibility: every stop satisfies every `AccessNeed`.

And here is the implementation, so the contract above is not just prose:

```ts
/** Hard, per-day constraints. NOT shared with the validator on purpose. */
function satisfiesDay(o: Poi[], c: Ctx): boolean {
  if (o.length < c.b.minPerDay || o.length > c.b.maxPerDay) return false;             // :374-377
  if (earliestSchedule(o, c.t, 0) === null) return false;                             // :408-420
  if (new Set(o.map(p => p.id)).size !== o.length) return false;                      // :736-737
  for (const p of o)                                                                   // :402-406
    for (const need of c.t.accessNeeds)
      if (!need.ok && p.tags.includes(need.kind)) return false;
  if (o.length && o[0].tags.includes('MUST_BE_FIRST_POI') &&
      o[0].id !== c.t.startPoiId) return false;
  if (o.length && o[o.length - 1].tags.includes('MUST_BE_LAST_POI') &&
      o[o.length - 1].id !== c.t.endPoiId) return false;
  for (let i = 0; i < o.length; i++)                                                   // :492-500
    for (const succ of beforeOf(o[i], c)) {
      const j = o.findIndex(q => q.id === succ);
      if (j >= 0 && j <= i) return false;
    }
  const spend = o.reduce((s, p) => s + p.priceMinor, 0) * c.t.groupSize;
  return spend <= c.t.budgetMinor;                                                     // :103, done exactly
}

/** The successors of `p` that must come strictly after it, per the confirmed constraints. */
function beforeOf(p: Poi, c: Ctx): string[] { /* regex-mined, server-owned: candidate_builder.py:75-80 */ }

/** Position of `p` in `o`; -1 if absent. (Named so repairDay reads cleanly.) */
function orderIndex(o: Poi[], p: Poi): number { return o.findIndex(q => q.id === p.id); }
```

Everything else — ratings, diversity, distance, cross-cluster arcs, waiting, day balance — is the objective, never a hard constraint. Keeping that line crisp is the single most important design decision in the whole port.

**The search loop.** ILS with LAHC + adaptive penalties, ported from `pyvrp/IteratedLocalSearch.py:216-282` and `pyvrp/PenaltyManager.py:181-231`. ~40 lines, and it is what makes this competitive with CP-SAT on 30-60 POIs:

```ts
function ils(day: Poi[], c: Ctx, rng: Rng, iters: number): Poi[] {
  const H = 30;                                    // history_length (pyvrp: 89, scaled down)
  let twPenalty = 50_000.05;                       // midpoint_penalties (pyvrp:131)
  const TARGET = 0.65, TOL = 0.05, INC = 1.5, DEC = 0.9;   // pyvrp:84-87
  const hist: number[] = [];
  let best = [...day], bestCost = pathCost(day, c);
  let cur = [...day], curCost = bestCost;
  const recentInf: boolean[] = [];
  let noImp = 0;

  for (let it = 0; it < iters && noImp < 3000; it++) {
    // 1. one local-search step: 2-opt + Or-opt, skip anything that breaks feasibility
    const cand = localSearchStep(cur, c, rng);
    // 2. register feasibility, then adapt the penalty
    recentInf.push(!earliestSchedule(cand, c.t, 0));
    if (recentInf.length >= 50) {                   // solutions_between_updates = 50 (pyvrp:83, scaled)
      const p = recentInf.filter(Boolean).length / 50;
      twPenalty = Math.abs(TARGET - p) < TOL ? twPenalty
                : p < TARGET ? Math.min(1e5, twPenalty * INC)
                             : Math.max(0.1, twPenalty * DEC);
      recentInf.length = 0;
    }
    // 3. LAHC acceptance (pyvrp:262-278)
    const lateCost = hist.length ? hist[hist.length - H] : pathCost(cand, c);
    const candCost = pathCost(cand, c) + (earliestSchedule(cand, c.t, 0) ? 0 : twPenalty);
    if (candCost < bestCost) { best = cand; bestCost = candCost; noImp = 0; }
    else noImp++;
    if (candCost < lateCost || candCost < curCost) { cur = cand; curCost = candCost; }
    if (curCost < lateCost) hist.push(curCost); else hist.push(hist[hist.length - 1] ?? curCost);
    if (noImp >= 3000) { cur = [...best]; hist.length = 0; noImp = 0; }   // restart
  }
  return best;
}
```

**TIER 2 — the relaxation ladder.** This is FloatTrip's, and it is the honest replacement for unsat cores. Three tiers, one dropped constraint at a time, and *always reported*:

```ts
const LADDER: ReadonlyArray<{ relaxed: RelaxedConstraint[]; drop: (b: Budget) => Budget }> = [
  { relaxed: [],                                   drop: b => b },
  { relaxed: ['DAILY_MIN'],                       drop: b => ({ ...b, minPerDay: 1 }) },
  { relaxed: ['DAILY_MIN', 'WAITING_PENALTY'],    drop: b => ({ ...b, minPerDay: 1, maxPerDay: b.maxPerDay }) },
  { relaxed: ['DAILY_MIN', 'WAITING_PENALTY', 'CROSS_CLUSTER_ARC', 'DIVERSITY'],
    drop: b => ({ ...b, minPerDay: 1, clusters: Math.max(1, b.clusters - 1) }) },
];

function pack(cands: Poi[], c: Ctx, rng: Rng, budgetMs: number): Plan {
  for (let tier = 0; tier < LADDER.length; tier++) {
    const t0 = Date.now();
    const b = LADDER[tier].drop(c.b);
    const days = assignToDays(cands, b, c.score, c.t);
    if (days.some(d => d.length < b.minPerDay)) continue;                 // next tier
    const routed = days.map(d => ils(repairDay(d, c, rng), { ...c, b }, rng, 20_000));
    const plan = assemble(routed, c, b);
    if (validate(plan, c, b, /*allowRelaxed*/ tier > 0).violations.length === 0)
      return { ...plan, diagnostics: { ...plan.diagnostics, tier: tier === 0 ? 'ils' : 'insert',
                                      relaxed: LADDER[tier].relaxed, elapsedMs: Date.now() - t0 } };
    if (Date.now() - t0 > budgetMs) break;
  }
  return assemble([], c, c.b);   // caller turns violations[] into "no feasible plan + here is what to drop"
}
```

The key property, and the reason to prefer this over `unsat_core()`: **every tier is a named, logged, user-explainable relaxation.** `unsat_core()` gives you constraint labels, not a repair plan, and (as TripWeaver proves) nothing reads them.

### 9.7 STAGE D — the independent validator

Non-negotiable, and it must not share code with the packer's feasibility logic, or it cannot catch the packer's bugs. This is `floattrip/optimizer.py:705-812` and it is the single highest-value idea in the whole corpus.

```ts
export function validate(plan: Plan, c: Ctx, b: Budget, allowRelaxed = false): { violations: Violation[] } {
  const v: Violation[] = [];
  const seen = new Set<string>();
  const perDay = new Map<number, Poi[]>();
  for (const s of plan.stops) {
    if (seen.has(s.poiId)) v.push({ code: 'DUPLICATE_POI', message: s.poiId, day: s.day, poiId: s.poiId });
    seen.add(s.poiId);
    (perDay.get(s.day) ?? perDay.set(s.day, []).get(s.day)!).push(byId(s.poiId));
  }
  for (const [day, pois] of perDay) {
    const min = allowRelaxed ? 1 : b.minPerDay;
    if (pois.length < min || pois.length > b.maxPerDay)
      v.push({ code: 'DAILY_COUNT', message: `${pois.length} outside ${min}-${b.maxPerDay}`, day });

    // the schedule must BE the earliest feasible one, recomputed from scratch
    const recomputed = earliestSchedule(pois, c.t, 0);
    if (!recomputed) v.push({ code: 'TIME_WINDOW', message: 'no feasible order for this day', day });
    else recomputed.forEach(([s, e], i) => {
      const st = plan.stops.find(x => x.day === day && x.poiId === pois[i].id)!;
      if (st.startMin !== s || st.endMin !== e) v.push({ code: 'SCHEDULE_DRIFT', message: pois[i].id, day, poiId: pois[i].id });
    });

    // ordering constraints, checked on (day, position) lexicographically
    for (const p of pois) for (const succ of beforeOf(p, c)) {
      const j = pois.findIndex(q => q.id === succ);
      if (j < 0) continue;
      if (j <= pois.indexOf(p))
        v.push({ code: 'PRECEDENCE', message: `${p.id} must precede ${succ}`, day, poiId: p.id });
    }
    // every access need
    for (const p of pois)
      for (const need of c.t.accessNeeds)
        if (!need.ok && p.tags.includes(need.kind))
          v.push({ code: 'ACCESS', message: `${need.kind} at ${p.id}`, day, poiId: p.id });
  }
  // must-visit present at all
  for (const p of cands) if (isMustSee(p, c) && !seen.has(p.id))
    v.push({ code: 'MISSING_MUST_VISIT', message: p.id, poiId: p.id });
  // budget
  const spend = plan.stops.reduce((s, x) => s + priceMinor(byId(x.poiId)) * c.t.groupSize, 0);
  if (spend > c.t.budgetMinor) v.push({ code: 'BUDGET', message: `${spend} > ${c.t.budgetMinor}` });
  // OBJECTIVITY: recompute the score from the plan alone and compare
  const recomputedObj = scorePlan(plan, c);
  if (Math.abs(recomputedObj - plan.objective) > 1e-6)
    v.push({ code: 'OBJECTIVE_MISMATCH', message: `delta=${(recomputedObj - plan.objective).toFixed(8)}` });
  return { violations: v };
}
```
The `OBJECTIVE_MISMATCH` check is what makes this trustworthy: `scorePlan` is a second, independent implementation of the objective over the finished plan, so a bug in the ILS cost function shows up as a mismatch instead of silently producing a bad plan. `floattrip/scoring.py:111-200` is the model.

**Small helpers referenced above and assumed to exist** (all trivial, listed so nothing is magic):
`cosine(vec, cands) -> number[]` (dot of a unit vector against each `Poi.emb`),
`fuzzy(a, b) -> 0..100` (levenshtein-ratio; the `> 91` cutoff is ITINERA's `thefuzz` threshold, `utils/funcs.py:19`),
`TRANSFER_MIN = 20`, `d2(a, b)` metres, `byId(id)`, `priceMinor(poi)`,
`isMustSee(poi)`, `assemble(routedDays, c, b) -> Plan` (flatten day orders into `Plan.stops` with start/end/distance),
`localSearchStep(order, c, rng) -> Poi[]` (one 2-opt + one Or-opt pass that keeps the result feasible).

### 9.8 Re-solve when circumstances change

The cheapest, most valuable re-solve: **warm-start from the previous order instead of rebuilding.**

```
onChange(prevPlan, event):
  if event.kind == 'poiClosed'  -> validate(prevPlan) -> pack() with the closed POI removed
  if event.kind == 'timeShift'  -> re-run earliestSchedule on each day in the NEW order;
                                  if any day returns null, run ILS on that day only (seconds)
  if event.kind == 'groupSize'  -> re-check maxPerDay and budget; ILS on affected days
  if event.kind == 'budgetDrop' -> ILS over the whole plan with the new budget as a HARD cap
  if event.kind == 'accessNeed' -> hard filter, then ILS
  ALWAYS: validate() before returning, and diff the violation list against the previous run
```

Because the plan is a set of independent day-orders, a change to day 3 does not require touching days 1, 2, 4. This is a direct payoff of ITINERA's "one cluster == one day" structure and of FloatTrip's `days: Day[]` state, and it is the reason to keep the plan as an explicit ordered list of days rather than a single flat route. Two of the seven repos preserve enough state to do this (FloatTrip's `candidate_pool_frozen` + revision graph, `nodes.py:391`, `graph.py:154-181`); ITINERA, TripWeaver, UGuideRAG and RouteMind all regenerate from scratch and therefore cannot re-solve cheaply.

### 9.9 Line budget

| Module | Lines | Source |
|---|---|---|
| `types.ts` (data structures above) | 130 | — |
| `decompose.ts` (LLM + `safeParseLlmJson` + schema guard) | 90 | itinera `process_input_prompt` + funcs `thefuzz` |
| `filter.ts` + `rank.ts` | 120 | itinera spatial.py:24-48, itinera.py:235-241, search.py:97-121 |
| `cluster.ts` (Bron-Kerbosch + peel + select + order + stitch) | 200 | itinera spatial.py:50-87, 188-208, 244-307; itinera.py:283-295 |
| `packer.ts` (assign + earliestSchedule + Held-Karp + 2-opt/Or-opt + ILS + ladder) | 320 | floattrip optimizer.py:207-261, 332-601; pyvrp IteratedLocalSearch |
| `score.ts` (scalarised objective + breakdown) | 90 | floattrip scoring.py |
| `validate.ts` | 110 | floattrip optimizer.py:705-812 |
| `resolve.ts` (re-solve ladder) | 70 | **new** — no repo has this |
| tests | 250 | — |
| **total** | **~1380** | |

For comparison, the seven repos together are ~11 000 lines of Python across 4 solver stacks, three of which (PuLP, Z3, OR-Tools CP-SAT) do work a 1380-line dependency-free TypeScript engine does not need to do.

---

## CLAIMS THAT DID NOT SURVIVE CHECKING

Each of these is stated in a README, a file name, a docstring, a prompt, or the `repos.tsv` manifest, and is **false or materially overstated** relative to the code.

1. **`systems/routemind-pritesh` is described as "RAG + embeddings + OR-Tools + Google Maps".** It is an LLM-provider router for a chat app. `ortools` -> NONE. `itinerary`/`travel`/`poi` -> NONE. `README.md:1-5` says so outright. The description is copy-pasted verbatim from `repos.tsv:86` (the *other* RouteMind). `repos.tsv:111`.
2. **There is no `peer/routemind-pritesh/` directory.** The clone landed at `systems/routemind-pritesh/` per `MANIFEST.json:1619-1623`. Also, `peer/routemind` is described as a "JS" project; it is FastAPI/Python + a Next.js/TS frontend.
3. **No project in this corpus uses OR-Tools' *routing* library.** `ortools.constraint_solver`, `routing.Model`, `RoutingIndexManager`, `AddDimension` -> NOT PRESENT IN CODE in any of the seven repos. Both users (`peer/routemind`, `peer/floattrip`) use `ortools.sat.python.cp_model` only. The claim that RouteMind shows "how a real project wires a routing solver" is not supported.
4. **`z3_temporal_scheduler_with_relaxation.py`'s relaxation is not relaxation.** It is a fixed, hand-written demotion of exactly two hard constraints to penalty variables, with a `minimize`. No loop, no re-solve, no core, no assumptions. `unsat_core()` is called at `:684` on a solver with zero tracked assumptions, so it always returns empty. `assert_and_track` / `assumption` -> NOT PRESENT IN CODE in that file.
5. **TripWeaver reads its own unsat core.** It does not. `prompts/solve_*.txt` writes `unsat_info.txt`; **no code anywhere reads that file.** The `'budget enough'` label exists in `prompts/step_to_code_budget.txt:15` and is never acted on. The only recovery is re-rolling the LLM.
6. **TripWeaver's temporal scheduler checks the budget or item quality.** It does not. `Array`/`Select` encodes only `city -> count` (`L182-206`); item identity is assigned post-hoc by enumeration order (`L691-692`, `L804-809`). Price, category and dedup are unrepresentable inside the model.
7. **TripWeaver's `minimize(total_penalty)` prioritises the penalty.** It does not. `opt.minimize` (`:406`) and `opt.maximize` (`:502`, `:590`) on the same `Optimize` object are lexicographically ordered, so the penalty objective has the **lowest** priority — the entire point of the "relaxation" is silently defeated.
8. **UGuideRAG's `SpatialSolver.get_clusters()` works.** It raises `NameError` — `SpatialSolver.py` imports only `from scipy.spatial.distance import cdist` yet calls `scipy.spatial.distance.cdist` (`:25`) and `nx.Graph()` (`:28`) / `nx.find_cliques` (`:42`). `networkx` is never imported. `get_candidates()` -> `get_ordered_candidates()` -> `route_planner()` are all dead. `NOT PRESENT IN CODE` as runnable code.
9. **UGuideRAG performs "dimension-aware retrieval" then merges.** It does not. The three cosine similarities are computed in one pass over one candidate set and immediately linearly combined (`SearchEngine.py:151-159`). No per-dimension top-k, rank, normalisation or re-ranking. `NOT PRESENT IN CODE` as a per-dimension retrieval strategy.
10. **UGuideRAG's decomposition can return multiple requirement sets.** Only `user_input_decomposition[0]` is read (`SearchEngine.py:118-120`); the rest are silently dropped.
11. **UGuideRAG's UGC-analysis / UADC module is in the repo.** It is not. `VA_desc.csv`, `VA_desc_embeddings.json`, `VA_wiki_Paris.csv` and every `Dataset/*/reviews/*.csv` are read by no code. The only Python files are `Code/{SearchEngine,SpatialSolver,UGuideRAG}.py`. `README.md` describes the UADC as module 1 of 4.
12. **UGuideRAG's spatial selection terminates.** It does not. `SpatialSolver.py:73-84` is an unbounded `while True` that grows the prefix by 1 and re-clusters each time, with no iteration cap. A spatially diffuse POI set never satisfies `valid_va_count >= min_vas`.
13. **UGuideRAG's SA is a competent TSP solver.** It is a uniform random 2-swap with an absolute-metre temperature (`:130-133`, `:127`). No 2-opt, no insertion, no Or-opt; temperature has no cross-city meaning.
14. **RouteMind's `ortools_optimizer.py` is an OR-Tools itinerary optimiser.** It registers 3 real constraints (budget with a hardcoded 1.2x fudge, day-count band, must-visit >= 1) plus a tautology `x <= 1` on a BoolVar, and then orders/schedules greedily outside the solver (`:190`: `# Order activities using greedy (simpler than full TSP)`). Its own docstring at `:33` overclaims and `:49-51` retracts it.
15. **RouteMind's RAG ranking contributes to the plan.** It does not. `score_activity`'s `semantic_relevance_score` is passed `None` on both real paths (`ortools_optimizer.py:155`, `:238-240`). The pgvector ordering is retrieved, then only the *set* is used; the ordering is discarded. `app/api/schemas.py:100` still advertises the field.
16. **ITINERA's clustered candidate pool honours every must-see POI.** Not in the general path. `find_clusters_containing_all_elements` (`utils/funcs.py:321-340`) has `break` after the first hit, so it returns clusters containing **any** must-see, not **all** — contradicting its name and its docstring ("Return indexes of clusters in A that contain all elements of B").
17. **ITINERA's `distance_thresh` scales with the trip length.** The citywalk path does (`:48`); the general fallback path uses the hardcoded constructor default `thresh=1000` (`:35` -> `spatial.py:270`) for every trip length.
18. **ITINERA's start-point LLM call influences the route.** For the first cluster it does not: `plan_candidates` is built, the prompt is built at `:320-328`, and `id2content[0]` is taken unconditionally at `:425`. The LLM result is discarded on that path. (It *is* used on the "no bridge pair" path, `:328`.)
19. **ITINERA's `distance_string` informs the start-point choice.** The prompt template `get_start_point_prompt` (`all_en_prompts.py:86-130`) never interpolates `{distance_string}`. Dead input.
20. **TripWeaver's generated code is validated before running.** It is not. The only sanitisation is three string replacements and a blind text re-indent (`run_planner.py:344-357`); execution is raw `exec` (`:406`, `z3_code_execution.py:192`). No AST check, no lint, no schema check.
21. **PyVRP supports client groups beyond mutual exclusion.** `mutuallyExclusive` is `const = true` and hard-coded (`cpp/ClientGroup.h:50`); `ClientGroup.h:19-21` says *"Only mutually exclusive client groups are supported for now."* `Model.py:274-277` rejects required-in-mutually-exclusive.
22. **PyVRP has precedence/sequencing constraints.** It does not. `Client` has no `before`/`after` field; `release_time` bounds *depot departure*, not arrival, so it cannot order two clients on the same route.
23. **PyVRP has hard time windows.** It does not. Windows are soft and accumulate time warp (`cpp/Route.cpp:230`, `:252-253`); `cost()` returns `MAX` for anything with `time_warp > 0` (`cpp/CostEvaluator.h:212-218`) but the search optimises `penalised_cost`.
24. **PyVRP's penalty manager balances distance, rewards and penalties.** It manages exactly three channels — per-load-dimension excess, time warp, and *excess* distance (`PenaltyManager.py:171-179`, `:233-244`). It never touches distance-as-objective or prizes. On a normal instance `excess_distance()` is 0, so it is effectively a one-channel time-warp controller.
25. **UGuideRAG's "0.6 / 0.5 / 0.5 average similarity" is an average.** It is an unnormalised weighted sum totalling 1.6, hard-coded, with no config and no ablation (`SearchEngine.py:156`).
26. **UGuideRAG's decomposition has a `avoid` / negative channel.** It does not. The prompt declares three *positive* fields only (`SearchEngine.py:24-38`); "Negative Filtering" is one guideline inside the reranker prompt (`UGuideRAG.py:51`).
27. **TripWeaver's `z3_temporal_scheduler*.py` reports UNSAT plans.** It does not. `BASE_PATH` (`L835`) points at `output/5d/qwen_nl`, absent from the repo, so the script cannot run; and on `plan == {}` the subsequent `plan["days"]` raises `KeyError` which is caught by the broad handler at `L880` and mis-filed as an *error*, not an unsat.
