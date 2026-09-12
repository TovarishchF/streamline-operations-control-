"""Пагинация в формате контракта: {data, meta}.

`openapi.yaml` PagedResponse. Стандартный формат DRF ({count, next, previous,
results}) не используется: контракт согласован с клиентами до кода.
"""

from __future__ import annotations

from collections import OrderedDict
from typing import Any

from rest_framework.pagination import PageNumberPagination
from rest_framework.response import Response


class SocPagination(PageNumberPagination):
    page_size = 50
    page_size_query_param = "perPage"
    page_query_param = "page"
    max_page_size = 200

    def get_paginated_response(self, data: Any) -> Response:
        # DRF вызывает этот метод только после paginate_queryset, который
        # заполняет page и request. Проверка делает это предположение явным.
        if self.page is None or self.request is None:
            raise RuntimeError("get_paginated_response вызван до paginate_queryset")

        return Response(
            OrderedDict(
                [
                    ("data", data),
                    (
                        "meta",
                        {
                            "total": self.page.paginator.count,
                            "page": self.page.number,
                            "perPage": self.get_page_size(self.request) or self.page_size,
                        },
                    ),
                ]
            )
        )

    def get_paginated_response_schema(self, schema: dict[str, Any]) -> dict[str, Any]:
        return {
            "type": "object",
            "required": ["data", "meta"],
            "properties": {
                "data": schema,
                "meta": {
                    "type": "object",
                    "required": ["total", "page", "perPage"],
                    "properties": {
                        "total": {"type": "integer"},
                        "page": {"type": "integer"},
                        "perPage": {"type": "integer"},
                    },
                },
            },
        }
